/**
 * scripts/admincli.sh against a REAL pg-mcp-server process (node src/index.js), real PostgreSQL and real Keycloak:
 * no stub API, no fake identity provider. What the CLI configures is checked by what the server then does.
 *
 *   docker compose --profile keycloak up -d --wait postgres-test keycloak
 *   PG_TEST_HOST=localhost PG_TEST_PORT=5433 OIDC_TEST_ISSUER=http://localhost:8081/realms/pg-mcp \
 *     npx vitest run tests/admincli.integration.test.js
 *
 * Skipped unless PG_TEST_HOST and a Keycloak issuer (OIDC_TEST_ISSUER with /realms/) are set, or bash/curl are missing.
 * Creates and drops the database pgmcp_cli and the role pgmcp_cli_user.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile, spawnSync } from "node:child_process";
import pg from "pg";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HOST = process.env.PG_TEST_HOST;
const PORT = parseInt(process.env.PG_TEST_PORT || "5433", 10);
const ISSUER = process.env.OIDC_TEST_ISSUER || "";
const SUPER = { user: process.env.PG_TEST_USER || "postgres", password: process.env.PG_TEST_PASSWORD || "postgres" };
const DB = "pgmcp_cli";
const OWN = { user: "pgmcp_cli_user", password: "clipw" };
const ADMIN_TOKEN = "cli-break-glass-token";
const SCRIPT = path.resolve(import.meta.dirname, "../scripts/admincli.sh").replace(/\\/g, "/");
const SERVER_ENTRY = path.resolve(import.meta.dirname, "../src/index.js");
const haveTools = ["bash", "curl"].every(c => spawnSync(c, ["--version"]).status === 0);
const enabled = !!HOST && ISSUER.includes("/realms/") && haveTools;

const pgClient = (database) => new pg.Client({ host: HOST, port: PORT, database, ...SUPER });
async function runSql(database, statements) {
  const c = pgClient(database);
  await c.connect();
  try { for (const s of statements) await c.query(s); } finally { await c.end(); }
}
const text = (result) => result.content.map(c => c.text).join("\n");

/** Access token of a Keycloak test user (password grant of the public client pgmcp-test). */
async function keycloakToken(user) {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "password", client_id: "pgmcp-test", username: user, password: user }),
  });
  expect(res.ok, await res.clone().text()).toBe(true);
  return (await res.json()).access_token;
}

describe.skipIf(!enabled)("admincli.sh against a real server (Keycloak + PostgreSQL)", () => {
  let dir, child, base, serverLog = "";
  const clients = [];

  beforeAll(async () => {
    await runSql("postgres", [`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, `DROP ROLE IF EXISTS ${OWN.user}`,
      `CREATE ROLE ${OWN.user} LOGIN PASSWORD '${OWN.password}'`, `CREATE DATABASE ${DB}`]);
    await runSql(DB, [`CREATE TABLE greetings (msg text)`, `INSERT INTO greetings VALUES ('hello from the CLI test')`,
      `GRANT CONNECT ON DATABASE ${DB} TO ${OWN.user}`, `GRANT SELECT ON greetings TO ${OWN.user}`]);

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgmcp-cli-"));
    const port = 3900 + Math.floor(Math.random() * 90);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? "",
        TRANSPORT: "http", PORT: String(port), TOKENS_FILE: path.join(dir, "tokens.json"), AUTH_TOKEN: ADMIN_TOKEN,
        PG_HOST: HOST, PG_PORT: String(PORT), PG_DATABASE: "postgres", PG_USER: SUPER.user, PG_PASSWORD: SUPER.password,
        OAUTH_ISSUER: ISSUER, OAUTH_AUDIENCE: "api://pg-mcp", OAUTH_ADMIN_GROUPS: "grp-admin",
      },
    });
    child.stdout.on("data", d => { serverLog += d; });
    child.stderr.on("data", d => { serverLog += d; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`server did not start:\n${serverLog}`);
  }, 30000);

  afterEach(async () => { for (const c of clients.splice(0)) await c.close().catch(() => {}); });
  afterAll(async () => {
    child?.kill();
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
    await runSql("postgres", [`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, `DROP ROLE IF EXISTS ${OWN.user}`]).catch(() => {});
  });

  function cli(args, env = { AUTH_TOKEN: ADMIN_TOKEN }) {
    return new Promise(resolve => {
      const clean = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", MCP_URL: base };
      execFile("bash", [SCRIPT, ...args], { env: { ...clean, ...env } }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr });
      });
    });
  }

  async function open(token, headers = {}) {
    const client = new Client({ name: "cli-it", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
    }));
    clients.push(client);
    return client;
  }
  const sql = async (client, q) => text(await client.callTool({ name: "query", arguments: { sql: q } }));
  const WHO = "SELECT current_database() AS db, current_user AS usr, application_name AS app FROM pg_stat_activity WHERE pid = pg_backend_pid()";

  it("health, and whoami with the break-glass token", async () => {
    const h = await cli(["health"], {});
    expect(h.code).toBe(0);
    expect(h.out).toContain("ok");
    const w = await cli(["whoami"]);
    expect(w.code).toBe(0);
    expect(w.out).toContain(ISSUER);
  });

  it("a Keycloak admin's access token works as ADMIN_TOKEN; a normal user's does not", async () => {
    const root = await cli(["whoami"], { ADMIN_TOKEN: await keycloakToken("root") });
    expect(root.code).toBe(0);
    expect(root.out).toContain("root@example.com");
    expect(root.out).toContain("oauth");

    const alice = await cli(["list-assignments"], { ADMIN_TOKEN: await keycloakToken("alice") });
    expect(alice.code).not.toBe(0);
    expect(alice.out).toMatch(/HTTP 40[13]/);
    expect((await cli(["list-tokens"], { AUTH_TOKEN: "wrong" })).code).not.toBe(0);
  });

  it("add-token with a connection: the new token reaches that database through a real MCP client", async () => {
    const r = await cli(["add-token", "cli-sales", "--host", HOST, "--port", String(PORT), "--database", DB,
      "--user", SUPER.user, "--password", SUPER.password, "--ssl", "false"]);
    expect(r.code).toBe(0);
    const token = /TOKEN[^\n]*\n\s*\n\s*(\S+)/.exec(r.out)?.[1];
    const tokenId = /ID: (\d+)/.exec(r.out)?.[1];
    expect(token).toBeTruthy();

    const who = await sql(await open(token), WHO);
    expect(who).toContain(DB);
    expect(who).toContain("pg-mcp-server:cli-sales");
    expect(await sql(await open(token), "SELECT msg FROM greetings")).toContain("hello from the CLI test");

    const list = await cli(["list-tokens"]);
    expect(list.out).toContain("cli-sales");
    expect(list.out).toContain("yes");
    const shown = await cli(["show-token", tokenId]);
    expect(shown.out).toContain(`${HOST}:${PORT}/${DB}`);
  });

  it("disable-token / enable-token / delete-token take effect on the real server", async () => {
    const created = await cli(["add-token", "cli-toggle", "--host", HOST, "--port", String(PORT), "--database", DB, "--user", SUPER.user, "--password", SUPER.password]);
    const id = /ID: (\d+)/.exec(created.out)[1];
    const token = /TOKEN[^\n]*\n\s*\n\s*(\S+)/.exec(created.out)[1];
    expect(await sql(await open(token), "SELECT 1 AS one")).toContain("1");

    await cli(["disable-token", id]);
    await expect(open(token)).rejects.toThrow();
    await cli(["enable-token", id]);
    expect(await sql(await open(token), "SELECT 2 AS two")).toContain("2");
    expect((await cli(["delete-token", id])).code).toBe(0);
    await expect(open(token)).rejects.toThrow();
  });

  it("add-token --client-connection credentials: the client logs in with its own database account", async () => {
    const created = await cli(["add-token", "cli-own", "--host", HOST, "--port", String(PORT), "--database", DB,
      "--user", SUPER.user, "--password", SUPER.password, "--client-connection", "credentials"]);
    const token = /TOKEN[^\n]*\n\s*\n\s*(\S+)/.exec(created.out)[1];
    const who = await sql(await open(token, { "X-Pg-User": OWN.user, "X-Pg-Password": OWN.password }), WHO);
    expect(who).toContain(OWN.user);
    // without the permission the same headers are refused
    const id = /ID: (\d+)/.exec(created.out)[1];
    await cli(["set-client-conn", id, "none"]);
    await expect(open(token, { "X-Pg-User": OWN.user, "X-Pg-Password": OWN.password })).rejects.toThrow();
  });

  it("add-assignment: the Keycloak group decides the database, the e-mail shows up in PostgreSQL", async () => {
    const r = await cli(["add-assignment", "--group", "grp-dba", "--host", HOST, "--port", String(PORT), "--database", DB,
      "--user", SUPER.user, "--password", SUPER.password, "--ssl", "false", "--note", "DBAs"]);
    expect(r.code).toBe(0);
    const id = /ID: (\w+)/.exec(r.out)[1];

    const aliceToken = await keycloakToken("alice");
    const who = await sql(await open(aliceToken), WHO);
    expect(who).toContain(DB);
    expect(who).toContain("pg-mcp-server:alice@example.com");
    expect(await sql(await open(aliceToken), "SELECT msg FROM greetings")).toContain("hello from the CLI test");

    // eve is in grp-other: valid token, no assignment -> refused
    await expect(open(await keycloakToken("eve"))).rejects.toThrow();

    const list = await cli(["list-assignments"]);
    expect(list.out).toContain("grp-dba");
    expect(list.out).toContain(`/${DB}`);
    const shown = await cli(["show-assignment", id]);
    expect(shown.out).toContain("DBAs");
    expect(shown.out).toContain(DB);

    // clearing the connection falls back to the server default (database "postgres")
    await cli(["clear-assignment-conn", id]);
    expect(await sql(await open(aliceToken), WHO)).not.toContain(DB);
    await cli(["set-assignment-conn", id, JSON.stringify({ host: HOST, port: PORT, database: DB, user: SUPER.user, password: SUPER.password, ssl: "false" })]);
    expect(await sql(await open(aliceToken), WHO)).toContain(DB);

    expect((await cli(["delete-assignment", id])).code).toBe(0);
    await expect(open(aliceToken)).rejects.toThrow();
  });

  it("add-assignment --admin gives a user access to the admin API; --email with *@domain admits everybody of the domain", async () => {
    const evesToken = await keycloakToken("eve");
    expect((await cli(["list-assignments"], { ADMIN_TOKEN: evesToken })).code).not.toBe(0);

    const domain = await cli(["add-assignment", "--email", "*@example.com"]);
    expect(domain.code).toBe(0);
    const domainId = /ID: (\w+)/.exec(domain.out)[1];
    expect(await sql(await open(evesToken), "SELECT 42 AS answer")).toContain("42"); // default connection

    const admin = await cli(["add-assignment", "--email", "eve@example.com", "--admin"]);
    const adminId = /ID: (\w+)/.exec(admin.out)[1];
    expect((await cli(["list-assignments"], { ADMIN_TOKEN: evesToken })).code).toBe(0);
    await cli(["set-assignment-admin", adminId, "false"]);
    expect((await cli(["list-assignments"], { ADMIN_TOKEN: evesToken })).code).not.toBe(0);

    await cli(["delete-assignment", adminId]);
    await cli(["delete-assignment", domainId]);
    await expect(open(evesToken)).rejects.toThrow();
  });

  it("the server log shows who changed what (AUDIT for OAuth admins)", async () => {
    const added = await cli(["add-assignment", "--group", "audit-group"], { ADMIN_TOKEN: await keycloakToken("root") });
    await cli(["delete-assignment", /ID: (\w+)/.exec(added.out)[1]]);
    await new Promise(r => setTimeout(r, 200));
    expect(serverLog).toMatch(/\[AUDIT\][^\n]*root@example\.com[^\n]*POST \/admin\/assignments/);
  });
});
