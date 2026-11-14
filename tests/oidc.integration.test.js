/**
 * Integration test against a real OIDC provider (mock-oauth2-server container, no mocks for fetch or crypto).
 *
 *   docker compose --profile oidc up -d oidc-test
 *   OIDC_TEST_ISSUER=http://localhost:8080/default npx vitest run tests/oidc.integration.test.js
 *
 * Skipped unless OIDC_TEST_ISSUER is set. The users alice (grp-dba), bob (grp-users), eve (grp-other)
 * and root (grp-admin) are defined in tests/oidc/mock-oauth2-config.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { checkAuth, authenticateAdmin, clearTokenStoreCache } from "../src/lib.js";
import { handleOAuthRoute } from "../src/oauth-routes.js";
import { clearOAuthCache } from "../src/oauth.js";
import { makeReq, makeRes, resBody } from "./helpers.js";

const ISSUER = process.env.OIDC_TEST_ISSUER;

/** Access token for a user defined in the mock provider (client credentials grant, `scope` selects the user). */
async function tokenFor(user) {
  const res = await fetch(`${ISSUER}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: "pg-mcp-test", client_secret: "x", scope: user }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()).access_token;
}

describe.skipIf(!ISSUER)("OIDC integration (mock-oauth2-server)", () => {
  let dir; const saved = {};
  const ENV = {
    OAUTH_ISSUER: ISSUER, OAUTH_AUDIENCE: "api://pg-mcp", OAUTH_CLIENT_ID: "pgmcp-web",
    OAUTH_PUBLIC_URL: "http://localhost:3000", OAUTH_ADMIN_GROUPS: "grp-admin",
    OAUTH_ASSIGNMENTS: JSON.stringify([
      { group: "grp-dba", connection: { host: "dba-db", database: "prod", user: "dba" }, client_connection: "credentials" },
      { user: "bob@example.com", connection: { host: "bob-db" } },
      { group: "grp-users" },
    ]),
  };

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgmcp-oidc-")); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => {
    for (const k of [...Object.keys(ENV), "AUTH_TOKEN", "TOKENS_FILE"]) saved[k] = process.env[k];
    Object.assign(process.env, ENV, { TOKENS_FILE: path.join(dir, "tokens.json") });
    delete process.env.AUTH_TOKEN;
    clearOAuthCache(); clearTokenStoreCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
  });

  const mcp = async (user) => {
    const res = makeRes();
    const auth = await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: `Bearer ${await tokenFor(user)}` } }), res);
    return { auth, res };
  };

  it("group of the user decides the default connection", async () => {
    const { auth } = await mcp("alice");
    expect(auth).toMatchObject({ ok: true, name: "alice@example.com", connection: { host: "dba-db", database: "prod" }, clientConnection: "credentials" });
    expect(auth.identity).toMatchObject({ sub: "oid-alice", email: "alice@example.com", name: "Alice DBA" });
  });

  it("the user's e-mail assignment beats the group assignment", async () => {
    const { auth } = await mcp("bob");
    expect(auth).toMatchObject({ ok: true, connection: { host: "bob-db" } });
  });

  it("denies a valid token of a user without assignment", async () => {
    const { auth, res } = await mcp("eve");
    expect(auth).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(console.error.mock.calls.map(c => c[0]).join("\n")).toMatch(/\[WARN\] \[AUTH\] result="denied" token="eve@example\.com"/);
  });

  it("rejects a token from this provider for another audience", async () => {
    process.env.OAUTH_AUDIENCE = "api://somebody-else";
    const { auth, res } = await mcp("alice");
    expect(auth).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("rejects a token with a manipulated payload (signature checked against the provider's JWKS)", async () => {
    const [h, p, s] = (await tokenFor("eve")).split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url"));
    claims.groups = ["grp-admin"];
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    const res = makeRes();
    expect(await checkAuth(makeReq("POST", "/mcp", { headers: { authorization: `Bearer ${forged}` } }), res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("admin API: only members of the admin group", async () => {
    const asAdmin = await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: { authorization: `Bearer ${await tokenFor("root")}` } }), makeRes());
    expect(asAdmin).toMatchObject({ ok: true, name: "root@example.com", method: "oauth" });
    const res = makeRes();
    const asUser = await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: { authorization: `Bearer ${await tokenFor("alice")}` } }), res);
    expect(asUser).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it("browser login: authorization code flow with PKCE creates an admin session", async () => {
    const route = async (url, headers = {}) => {
      const res = makeRes();
      await handleOAuthRoute(makeReq("GET", url, { headers: { authorization: "", ...headers } }), res);
      return res;
    };
    // 1. our /auth/login redirects to the provider
    const login = await route("/auth/login");
    const authorizeUrl = login.writeHead.mock.calls[0][1].Location;
    expect(authorizeUrl.startsWith(`${ISSUER}/authorize?`)).toBe(true);
    // 2. the provider (non-interactive) redirects back with code and state
    const idpRes = await fetch(authorizeUrl, { redirect: "manual" });
    expect(idpRes.status).toBe(302);
    const back = new URL(idpRes.headers.get("location"));
    expect(back.pathname).toBe("/auth/callback");
    // 3. our callback exchanges the code, validates the id_token and sets the session cookie
    const cb = await route(`${back.pathname}${back.search}`);
    expect(cb.writeHead.mock.calls[0][0]).toBe(302);
    const cookie = cb.writeHead.mock.calls[0][1]["Set-Cookie"].split(";")[0];
    const status = resBody(await route("/auth/status", { cookie }));
    expect(status).toMatchObject({ authenticated: true, admin: true, user: { email: "root@example.com" } });
    expect(await authenticateAdmin(makeReq("GET", "/admin/tokens", { headers: { authorization: "", cookie } }), makeRes())).toMatchObject({ ok: true });
  });
});
