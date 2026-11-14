import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";

/**
 * scripts/admincli.sh against a stub admin API: checks the requests the CLI sends (method, path, body, bearer
 * token) and its output. Skipped where bash or curl are missing; the table output needs python3 only for the
 * pretty printing and is not asserted beyond the content.
 */
const SCRIPT = path.resolve(import.meta.dirname, "../scripts/admincli.sh").replace(/\\/g, "/");
const haveTools = ["bash", "curl"].every(c => spawnSync(c, ["--version"]).status === 0);

const seen = [];
let server;
let base = "";

const ASSIGNMENTS = [
  { id: "env-1", group: "grp-dba", source: "env", connection: null },
  { id: 1, group: "grp-users", source: "store", connection: { host: "db", database: "reports", user: "ro", password_set: true } },
  { id: 2, user: "alice@example.com", admin: true, client_connection: "credentials", source: "store", connection: null },
];
const TOKENS = [
  { id: 1, name: "ci", active: true, created_at: "2026-11-01T10:00:00.000Z", last_used_at: null, connection: null },
  { id: 2, name: "analytics", active: false, created_at: "2026-11-02T10:00:00.000Z", last_used_at: "2026-11-03T10:00:00.000Z",
    connection: { host: "db.example.com", port: 5432, database: "mydb", user: "u", ssl: "false" } },
];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? "", body });
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/health") return send(200, { status: "ok", tls: false });
      if (req.url === "/admin/me") return send(200, { name: "root@example.com", method: "oauth", email: "root@example.com", oauth: { issuer: "https://idp", groups_claim: "groups", session_ttl: 28800 } });
      if (req.url === "/admin/assignments" && req.method === "GET") return send(200, { assignments: ASSIGNMENTS });
      if (req.url === "/admin/assignments" && req.method === "POST") return send(201, { id: 7, ...JSON.parse(body) });
      if (req.url === "/admin/tokens" && req.method === "GET") return send(200, { tokens: TOKENS });
      if (req.url === "/admin/tokens" && req.method === "POST") return send(201, { id: 3, token: "tok-123", ...JSON.parse(body) });
      if (req.url === "/admin/assignments/9" || req.url === "/admin/tokens/9") return send(404, { error: "Not found" });
      if (req.url?.startsWith("/admin/")) return send(200, { ok: true, ...(body ? JSON.parse(body) : {}) });
      send(404, { error: "Not found" });
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => { server?.close(); });

function cli(args, env = { AUTH_TOKEN: "tok" }) {
  seen.length = 0;
  return new Promise(resolve => {
    // no PG_* from the developer's environment: the CLI reads them as defaults
    const clean = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", MCP_URL: base };
    execFile("bash", [SCRIPT, ...args], { env: { ...clean, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr });
    });
  });
}
const lastBody = () => JSON.parse(seen.at(-1).body);

describe.skipIf(!haveTools)("admincli.sh assignments", () => {
  it("whoami shows the identity", async () => {
    const r = await cli(["whoami"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("root@example.com");
    expect(seen[0]).toMatchObject({ method: "GET", url: "/admin/me", auth: "Bearer tok" });
  });

  it("accepts ADMIN_TOKEN (e.g. an OAuth access token) as alias", async () => {
    const r = await cli(["whoami"], { ADMIN_TOKEN: "jwt.value.here" });
    expect(r.code).toBe(0);
    expect(seen[0].auth).toBe("Bearer jwt.value.here");
  });

  it("refuses to run without a token", async () => {
    const r = await cli(["list-assignments"], {});
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("AUTH_TOKEN not set");
    expect(seen).toHaveLength(0);
  });

  it("list-assignments shows environment and stored entries", async () => {
    const r = await cli(["list-assignments"]);
    expect(r.code).toBe(0);
    for (const s of ["grp-dba", "grp-users", "alice@example.com", "db/reports (ro)", "credentials"]) expect(r.out).toContain(s);
  });

  it("show-assignment prints one entry, unknown id fails", async () => {
    const ok = await cli(["show-assignment", "2"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("alice@example.com");
    expect(ok.out).not.toContain("grp-users");
    expect((await cli(["show-assignment", "42"])).code).not.toBe(0);
  });

  it("add-assignment --group with a connection", async () => {
    const r = await cli(["add-assignment", "--group", "grp-dba", "--host", "dba-db", "--database", "prod", "--user", "dba", "--password", "p\"w\\x",
      "--ssl", "true", "--client-connection", "credentials", "--note", "DBAs"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ID: 7");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/admin/assignments" });
    expect(lastBody()).toEqual({
      group: "grp-dba", note: "DBAs", client_connection: "credentials",
      connection: { host: "dba-db", database: "prod", user: "dba", password: "p\"w\\x", ssl: "true" },
    });
  });

  it("add-assignment --email --admin without connection", async () => {
    const r = await cli(["add-assignment", "--email", "*@example.com", "--admin"]);
    expect(r.code).toBe(0);
    expect(lastBody()).toEqual({ user: "*@example.com", admin: true });
  });

  it("add-assignment sends only the given connection fields and ignores PG_* env vars", async () => {
    await cli(["add-assignment", "--group", "g", "--database", "sales", "--port", "5433"],
      { AUTH_TOKEN: "tok", PG_HOST: "from-env", PG_USER: "env-user" });
    expect(lastBody()).toEqual({ group: "g", connection: { port: 5433, database: "sales" } });
  });

  it("add-assignment validates its arguments", async () => {
    for (const args of [[], ["--group", "a", "--email", "b"], ["--group", "a", "--client-connection", "bogus"], ["--group", "a", "--bogus"], ["--group"]]) {
      const r = await cli(["add-assignment", ...args]);
      expect(r.code, args.join(" ")).not.toBe(0);
    }
    expect(seen).toHaveLength(0);
  });

  it("changes and deletes", async () => {
    expect((await cli(["delete-assignment", "1"])).code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "DELETE", url: "/admin/assignments/1" });

    expect((await cli(["set-assignment-conn", "1", '{"host":"x"}'])).code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "PATCH", url: "/admin/assignments/1" });
    expect(lastBody()).toEqual({ connection: { host: "x" } });

    await cli(["clear-assignment-conn", "1"]);
    expect(lastBody()).toEqual({ connection: null });

    await cli(["set-assignment-client-conn", "1", "full"]);
    expect(lastBody()).toEqual({ client_connection: "full" });

    await cli(["set-assignment-admin", "1", "true"]);
    expect(lastBody()).toEqual({ admin: true });

    expect((await cli(["set-assignment-client-conn", "1", "x"])).code).not.toBe(0);
    expect((await cli(["set-assignment-admin", "1", "maybe"])).code).not.toBe(0);
    expect((await cli(["delete-assignment"])).code).not.toBe(0);
  });

  it("reports API errors", async () => {
    const r = await cli(["delete-assignment", "9"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("HTTP 404");
  });
});

describe.skipIf(!haveTools)("admincli.sh tokens", () => {
  it("health needs no token", async () => {
    const r = await cli(["health"], {});
    expect(r.code).toBe(0);
    expect(r.out).toContain("ok");
    expect(seen[0]).toMatchObject({ method: "GET", url: "/health", auth: "" });
  });

  it("list-tokens and show-token", async () => {
    const list = await cli(["list-tokens"]);
    expect(list.code).toBe(0);
    for (const s of ["ci", "analytics", "false"]) expect(list.out).toContain(s);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/admin/tokens", auth: "Bearer tok" });

    const one = await cli(["show-token", "2"]);
    expect(one.code).toBe(0);
    expect(one.out).toContain("db.example.com:5432/mydb");
    expect(one.out).not.toContain("ci");
    expect((await cli(["show-token", "42"])).code).not.toBe(0);
  });

  it("add-token without connection sends only the name", async () => {
    const r = await cli(["add-token", "claude-desktop"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tok-123");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/admin/tokens" });
    expect(lastBody()).toEqual({ name: "claude-desktop" });
  });

  it("add-token builds the connection from flags", async () => {
    const r = await cli(["add-token", "prod", "--host", "db", "--database", "sales", "--user", "app", "--password", "pw", "--ssl", "verify", "--client-connection", "full"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("db:5432/sales");
    expect(lastBody()).toEqual({
      name: "prod", client_connection: "full",
      connection: { host: "db", port: 5432, database: "sales", user: "app", password: "pw", ssl: "verify" },
    });
  });

  it("add-token: flags beat PG_* env vars, env vars supply the rest", async () => {
    await cli(["add-token", "t", "--database", "flag-db"],
      { AUTH_TOKEN: "tok", PG_HOST: "env-host", PG_PORT: "6543", PG_DATABASE: "env-db", PG_USER: "env-user", PG_PASSWORD: "env-pw", PG_SSL: "true" });
    expect(lastBody().connection).toEqual({ host: "env-host", port: 6543, database: "flag-db", user: "env-user", password: "env-pw", ssl: "true" });
  });

  it("add-token escapes special characters in name and password", async () => {
    await cli(["add-token", 'we"ird\\name', "--host", "h", "--password", 'a"b\\c']);
    expect(lastBody()).toMatchObject({ name: 'we"ird\\name', connection: { password: 'a"b\\c' } });
  });

  it("add-token validates its arguments", async () => {
    for (const args of [[], ["t", "--client-connection", "bogus"], ["t", "--bogus"], ["t", "--group", "g"], ["t", "--host"]]) {
      const r = await cli(["add-token", ...args]);
      expect(r.code, args.join(" ")).not.toBe(0);
    }
    expect(seen).toHaveLength(0);
  });

  it("enable, disable, rename, set-conn, clear-conn, set-client-conn, delete", async () => {
    await cli(["enable-token", "2"]);
    expect(seen[0]).toMatchObject({ method: "PATCH", url: "/admin/tokens/2" });
    expect(lastBody()).toEqual({ active: true });
    await cli(["disable-token", "2"]);
    expect(lastBody()).toEqual({ active: false });
    await cli(["rename-token", "2", "new-name"]);
    expect(lastBody()).toEqual({ name: "new-name" });
    await cli(["set-conn", "2", '{"host":"h","database":"d"}']);
    expect(lastBody()).toEqual({ connection: { host: "h", database: "d" } });
    await cli(["clear-conn", "2"]);
    expect(lastBody()).toEqual({ connection: null });
    await cli(["set-client-conn", "2", "credentials"]);
    expect(lastBody()).toEqual({ client_connection: "credentials" });
    expect((await cli(["delete-token", "2"])).code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "DELETE", url: "/admin/tokens/2" });
    expect((await cli(["set-client-conn", "2", "x"])).code).not.toBe(0);
    expect((await cli(["rename-token", "2"])).code).not.toBe(0);
  });

  it("reports API errors and unknown commands", async () => {
    const r = await cli(["delete-token", "9"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("HTTP 404");
    const u = await cli(["frobnicate"]);
    expect(u.code).not.toBe(0);
    expect(u.out).toContain("Unknown command");
  });

  it("help lists the token and assignment commands", async () => {
    const r = await cli(["help"], {});
    expect(r.code).toBe(0);
    for (const c of ["list-tokens", "add-token", "set-client-conn", "list-assignments", "add-assignment", "whoami", "set-assignment-admin"]) expect(r.out).toContain(c);
  });
});
