/**
 * Integration tests against a real PostgreSQL (docker compose postgres-test), no mocks for pg or the MCP SDK.
 *
 *   docker compose up -d postgres-test
 *   PG_TEST_HOST=localhost PG_TEST_PORT=5433 npx vitest run tests/postgres.integration.test.js
 *
 * Skipped unless PG_TEST_HOST is set. Needs a superuser (PG_TEST_USER/PG_TEST_PASSWORD, default postgres/postgres);
 * creates the sample databases pgmcp_sales and pgmcp_hr and the role pgmcp_reader and drops them afterwards.
 *
 *  1. every MCP tool through a real MCP client (in-memory transport) on the sample "sales" database
 *  2. end to end over HTTP with OAuth: the group/e-mail of the user decides the database, application_name and
 *     client-supplied credentials are checked in PostgreSQL itself (fake identity provider, real fetch for the rest)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import pg from "pg";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpServer, getPool, handleRequest, poolCache, sessions } from "../src/index.js";
import { clearTokenStoreCache } from "../src/lib.js";
import { clearOAuthCache } from "../src/oauth.js";
import { makeIdp, ISSUER, AUDIENCE } from "./oidc-helpers.js";

const HOST = process.env.PG_TEST_HOST;
const PORT = parseInt(process.env.PG_TEST_PORT || "5433", 10);
const SUPER = { user: process.env.PG_TEST_USER || "postgres", password: process.env.PG_TEST_PASSWORD || "postgres" };
const ADMIN_DB = process.env.PG_TEST_DATABASE || "postgres";
const SALES = "pgmcp_sales";
const HR = "pgmcp_hr";
const READER = { user: "pgmcp_reader", password: "readerpw" };

const conn = (database, extra = {}) => ({ host: HOST, port: PORT, database, ...SUPER, ssl: "false", ...extra });
const connect = (database) => new pg.Client({ host: HOST, port: PORT, database, ...SUPER });
const text = (result) => result.content.map(c => c.text).join("\n");

async function runSql(database, statements) {
  const c = connect(database);
  await c.connect();
  try { for (const s of statements) await c.query(s); } finally { await c.end(); }
}

async function dropAll() {
  await runSql(ADMIN_DB, [
    ...[SALES, HR].map(d => `DROP DATABASE IF EXISTS ${d} WITH (FORCE)`),
    `DROP ROLE IF EXISTS ${READER.user}`,
  ]);
}

const SALES_DDL = [
  `CREATE TABLE customers (id serial PRIMARY KEY, name varchar(80) NOT NULL, country text)`,
  `CREATE TABLE orders (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id), amount numeric(10,2) NOT NULL, created_at timestamptz DEFAULT now())`,
  `CREATE INDEX orders_customer_idx ON orders (customer_id)`,
  `CREATE INDEX orders_amount_unused_idx ON orders (amount)`,
  `CREATE VIEW order_totals AS SELECT c.name, sum(o.amount) AS total FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name`,
  `INSERT INTO customers (name, country) VALUES ('Acme', 'DE'), ('Globex', 'US'), ('Initech', 'US')`,
  `INSERT INTO orders (customer_id, amount) SELECT 1 + (g % 3), g * 1.5 FROM generate_series(1, 300) g`,
  `ANALYZE`,
  `CREATE SCHEMA archive`,
  `CREATE TABLE archive.old_orders (id int PRIMARY KEY)`,
  `GRANT CONNECT ON DATABASE ${SALES} TO ${READER.user}`,
  `GRANT USAGE ON SCHEMA public TO ${READER.user}`,
  `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER.user}`,
];

const HR_DDL = [
  `CREATE TABLE employees (id serial PRIMARY KEY, name text NOT NULL, department text)`,
  `INSERT INTO employees (name, department) VALUES ('Ann', 'IT'), ('Ben', 'Sales')`,
];

describe.skipIf(!HOST)("PostgreSQL integration (sample databases)", () => {
  beforeAll(async () => {
    await dropAll();
    await runSql(ADMIN_DB, [
      `CREATE ROLE ${READER.user} LOGIN PASSWORD '${READER.password}'`,
      `CREATE DATABASE ${SALES}`, `CREATE DATABASE ${HR}`,
    ]);
    await runSql(SALES, SALES_DDL);
    await runSql(HR, HR_DDL);
  }, 60_000);

  afterAll(async () => {
    for (const p of poolCache.values()) await p.end().catch(() => {});
    poolCache.clear();
    await dropAll();
  }, 60_000);

  // ── 1. All tools against the sales database ─────────────────────────────────
  describe("MCP tools", () => {
    let client; let server;
    beforeAll(async () => {
      server = createMcpServer(getPool(conn(SALES), "tools-test"), "tools-test", "127.0.0.1");
      client = new Client({ name: "it", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterAll(async () => { await client.close(); vi.restoreAllMocks(); });

    const call = (name, args = {}) => client.callTool({ name, arguments: args });

    it("lists all tools", async () => {
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name).sort()).toEqual([
        "active_queries", "describe_table", "execute", "explain_query", "index_health", "list_schemas",
        "list_tables", "performance_overview", "query", "table_stats", "test_connection", "top_queries",
      ]);
    });

    it("test_connection reports database and user", async () => {
      const t = text(await call("test_connection"));
      expect(t).toContain(`Database   : ${SALES}`);
      expect(t).toContain(`User       : ${SUPER.user}`);
    });

    it("list_schemas / list_tables / describe_table", async () => {
      expect(text(await call("list_schemas"))).toMatch(/archive[\s\S]*public/);
      const tables = text(await call("list_tables"));
      expect(tables).toContain("TABLE: customers");
      expect(tables).toContain("TABLE: orders");
      expect(tables).toContain("VIEW: order_totals");
      expect(text(await call("list_tables", { schema: "archive" }))).toContain("old_orders");
      const d = text(await call("describe_table", { table: "customers" }));
      expect(d).toMatch(/id \| integer \| NO \| nextval.*\| PK/);
      expect(d).toContain("name | character varying(80) | NO");
      expect(text(await call("describe_table", { table: "nope" }))).toContain("not found");
    });

    it("query: results, parameters, empty result", async () => {
      expect(text(await call("query", { sql: "SELECT count(*) AS n FROM orders" }))).toContain("300");
      const r = text(await call("query", { sql: "SELECT name FROM customers WHERE country = $1 ORDER BY name", params: ["US"] }));
      expect(r).toContain("Globex");
      expect(r).toContain("Initech");
      expect(r).not.toContain("Acme");
      expect(text(await call("query", { sql: "SELECT 1 WHERE false" }))).toBe("Query returned 0 rows.");
      expect(text(await call("query", { sql: "SELECT * FROM order_totals ORDER BY name" }))).toContain("Acme");
    });

    it("query is read-only and runs a single statement", async () => {
      const w = await call("query", { sql: "DELETE FROM orders" });
      expect(w.isError).toBe(true);
      expect(text(w)).toMatch(/read-only/i);
      const multi = await call("query", { sql: "COMMIT; DELETE FROM orders" });
      expect(multi.isError).toBe(true);
      expect(text(await call("query", { sql: "SELECT count(*) AS n FROM orders" }))).toContain("300");
    });

    it("execute changes data transactionally and reports errors", async () => {
      expect(text(await call("execute", { sql: "INSERT INTO customers (name, country) VALUES ($1, $2)", params: ["Umbrella", "UK"] })))
        .toContain("Rows affected: 1");
      expect(text(await call("query", { sql: "SELECT country FROM customers WHERE name = 'Umbrella'" }))).toContain("UK");
      const bad = await call("execute", { sql: "INSERT INTO orders (customer_id, amount) VALUES (999, 1)" });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/foreign key/i);
      expect(text(await call("execute", { sql: "DELETE FROM customers WHERE name = 'Umbrella'" }))).toContain("Rows affected: 1");
    });

    it("explain_query: plan, analyze, json, generic plan, read-only", async () => {
      expect(text(await call("explain_query", { sql: "SELECT * FROM orders WHERE customer_id = $1", params: [1] }))).toMatch(/Scan on orders/);
      const an = text(await call("explain_query", { sql: "SELECT * FROM orders", analyze: true }));
      expect(an).toMatch(/Execution Time/);
      expect(JSON.parse(text(await call("explain_query", { sql: "SELECT 1", format: "json" })))[0]).toHaveProperty("Plan");
      const g = await call("explain_query", { sql: "SELECT * FROM orders WHERE id = $1", generic_plan: true });
      expect(text(g)).toMatch(/Scan/); // PostgreSQL 16+
      const w = await call("explain_query", { sql: "DELETE FROM orders", analyze: true });
      expect(w.isError).toBe(true); // runs in a read-only transaction: EXPLAIN ANALYZE cannot execute a write
      expect(text(w)).toMatch(/read-only/i);
      expect(text(await call("query", { sql: "SELECT count(*) AS n FROM orders" }))).toContain("300");
    });

    it("table_stats, index_health, active_queries, performance_overview", async () => {
      expect(text(await call("table_stats", { schema: "public" }))).toContain("orders");
      const idx = text(await call("index_health", { schema: "public" }));
      expect(idx).toContain("orders_amount_unused_idx"); // never used
      const act = await call("active_queries", {});
      expect(act.isError).toBeFalsy();
      const ov = text(await call("performance_overview"));
      expect(ov).toMatch(/cache|hit|connections/i);
    });

    it("top_queries answers (statistics may be unavailable without pg_stat_statements)", async () => {
      const r = await call("top_queries", {});
      expect(typeof text(r)).toBe("string");
      if (r.isError) expect(text(r)).toMatch(/pg_stat_statements/);
    });

    it("tool errors are reported, not thrown", async () => {
      const r = await call("query", { sql: "SELECT * FROM does_not_exist" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/does_not_exist/);
    });
  });

  // ── 2. End to end over HTTP with OAuth ──────────────────────────────────────
  describe("HTTP + OAuth: group / e-mail decide the database", () => {
    let srv; let url; let dir; let idp; let realFetch; let logs; const clients = [];
    const saved = {};
    const ENV = {
      OAUTH_ISSUER: ISSUER, OAUTH_AUDIENCE: AUDIENCE, OAUTH_ADMIN_USERS: "root@example.com",
      OAUTH_ASSIGNMENTS: JSON.stringify([
        { group: "grp-sales", connection: conn(SALES) },
        { group: "grp-hr", connection: conn(HR) },
        { user: "carol@example.com", connection: conn(SALES), client_connection: "credentials" },
      ]),
    };

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgmcp-pg-"));
      srv = http.createServer(handleRequest);
      await new Promise(r => srv.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${srv.address().port}/mcp`;
    });
    afterAll(async () => {
      await new Promise(r => srv.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(() => {
      for (const k of [...Object.keys(ENV), "AUTH_TOKEN", "TOKENS_FILE", "PG_HOST"]) saved[k] = process.env[k];
      Object.assign(process.env, ENV, { TOKENS_FILE: path.join(dir, "tokens.json"), PG_HOST: HOST });
      delete process.env.AUTH_TOKEN;
      clearOAuthCache(); clearTokenStoreCache();
      idp = makeIdp();
      realFetch = globalThis.fetch;
      // The fake provider answers for the issuer; everything else (MCP client -> server) uses the real fetch
      vi.stubGlobal("fetch", (u, init) => (String(u).startsWith(ISSUER) ? idp.fetch(u, init) : realFetch(u, init)));
      logs = [];
      vi.spyOn(console, "error").mockImplementation((m) => { logs.push(String(m)); });
    });
    afterEach(async () => {
      for (const c of clients.splice(0)) await c.close().catch(() => {});
      sessions.clear();
      vi.unstubAllGlobals(); vi.restoreAllMocks();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    });

    async function open(claims, headers = {}) {
      const token = idp.sign(claims);
      const client = new Client({ name: "it", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    }
    const sql = async (client, q) => text(await client.callTool({ name: "query", arguments: { sql: q } }));
    const WHO = "SELECT current_database() AS db, current_user AS usr, application_name AS app FROM pg_stat_activity WHERE pid = pg_backend_pid()";

    it("the group decides the database; application_name carries the user's e-mail", async () => {
      const alice = await open({ email: "alice@example.com", oid: "oid-alice", groups: ["grp-sales"] });
      const a = await sql(alice, WHO);
      expect(a).toContain(SALES);
      expect(a).toContain("pg-mcp-server:alice@example.com");
      expect(await sql(alice, "SELECT count(*) AS n FROM orders")).toContain("300");

      const bob = await open({ email: "bob@example.com", oid: "oid-bob", groups: ["grp-hr"] });
      const b = await sql(bob, WHO);
      expect(b).toContain(HR);
      expect(b).toContain("pg-mcp-server:bob@example.com");
      expect(await sql(bob, "SELECT name FROM employees ORDER BY id")).toContain("Ann");
      expect((await bob.callTool({ name: "query", arguments: { sql: "SELECT * FROM orders" } })).isError).toBe(true); // other database
    });

    it("both users are visible in pg_stat_activity at the same time (one pool per user)", async () => {
      const alice = await open({ email: "alice@example.com", groups: ["grp-sales"] });
      await open({ email: "bob@example.com", groups: ["grp-hr"] });
      await sql(alice, "SELECT 1");
      const admin = connect(ADMIN_DB);
      await admin.connect();
      try {
        const { rows } = await admin.query(
          "SELECT datname, application_name FROM pg_stat_activity WHERE application_name LIKE 'pg-mcp-server:%@example.com' ORDER BY 2");
        expect(rows.map(r => r.application_name)).toContain("pg-mcp-server:alice@example.com");
        expect(rows.find(r => r.application_name === "pg-mcp-server:alice@example.com").datname).toBe(SALES);
      } finally { await admin.end(); }
    });

    it("a user assignment beats the group assignment and may send own credentials (X-Pg-*)", async () => {
      const claims = { email: "carol@example.com", oid: "oid-carol", groups: ["grp-hr"] }; // group says hr, user says sales
      const carol = await open(claims);
      expect(await sql(carol, WHO)).toContain(SALES);

      const reader = await open(claims, { "X-Pg-User": READER.user, "X-Pg-Password": READER.password });
      const r = await sql(reader, WHO);
      expect(r).toContain(READER.user);
      expect(r).toContain(SALES);
      expect(await sql(reader, "SELECT count(*) AS n FROM customers")).toContain("3");
      const w = await reader.callTool({ name: "execute", arguments: { sql: "DELETE FROM customers" } });
      expect(w.isError).toBe(true);
      expect(text(w)).toMatch(/permission denied/i);
    });

    it("wrong client credentials fail in PostgreSQL, not silently", async () => {
      const bad = await open({ email: "carol@example.com", groups: [] }, { "X-Pg-User": READER.user, "X-Pg-Password": "wrong" });
      const r = await bad.callTool({ name: "query", arguments: { sql: "SELECT 1" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/password authentication failed/i);
    });

    it("client connection headers are refused for assignments with client_connection=none", async () => {
      await expect(open({ email: "alice@example.com", groups: ["grp-sales"] }, { "X-Pg-User": READER.user, "X-Pg-Password": READER.password }))
        .rejects.toThrow();
      expect(logs.join("\n")).toMatch(/reason="client connection: This token does not allow/);
    });

    it("a valid token without assignment is refused and logged", async () => {
      await expect(open({ email: "dave@example.com", groups: ["grp-other"] })).rejects.toThrow();
      expect(logs.join("\n")).toMatch(/\[AUTH\] result="denied" token="dave@example\.com"[^\n]*oauth: no assignment/);
    });

    it("audits the MCP session and logs the tool calls with the user's e-mail", async () => {
      const alice = await open({ email: "alice@example.com", oid: "oid-alice", groups: ["grp-sales"] });
      await sql(alice, "SELECT 1");
      const all = logs.join("\n");
      expect(all).toMatch(/\[INFO\] \[AUDIT\] user="alice@example\.com" sub="oid-alice" action="session_start" session="[\w-]+" via="oauth"/);
      expect(all).toMatch(/\[SESSION\] token="alice@example\.com" action="start"/);
      expect(all).toMatch(/\[MCP\] token="alice@example\.com" action="query"/);
    });
  });
});
