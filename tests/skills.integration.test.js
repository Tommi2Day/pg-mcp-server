/**
 * Skills (MCP prompts / Agent Skills) against a real PostgreSQL, no mocks.
 *
 *   docker compose up -d postgres-test          # starts with pg_stat_statements preloaded
 *   PG_TEST_HOST=localhost PG_TEST_PORT=5433 npx vitest run tests/skills.integration.test.js
 *
 * Skipped unless PG_TEST_HOST is set. Creates the database pgmcp_skills (dropped afterwards) and checks that
 *  - every prompt is served through a real MCP client and every SQL block of every skills/<name>/SKILL.md runs
 *    read-only through the `query` tool on the sample database (PostgreSQL 13+ catalog compatibility)
 *  - the SQL of pg-document returns the documented objects of a sample schema
 *  - pg-locks-waits / pg-top-sessions / pg-activity find a real blocking chain, an idle-in-transaction session and a
 *    running statement
 *  - pg-top-sql / pg-sql-tuning work on real pg_stat_statements data
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, getPool, poolCache, PROMPTS } from "../src/index.js";
import { SKILLS_DIR } from "../src/prompts.js";

const HOST = process.env.PG_TEST_HOST;
const PORT = parseInt(process.env.PG_TEST_PORT || "5433", 10);
const SUPER = { user: process.env.PG_TEST_USER || "postgres", password: process.env.PG_TEST_PASSWORD || "postgres" };
const ADMIN_DB = process.env.PG_TEST_DATABASE || "postgres";
const DB = "pgmcp_skills";

const newClient = (database, application_name) => new pg.Client({ host: HOST, port: PORT, database, ...SUPER, application_name });
const text = (r) => r.content.map(c => c.text).join("\n");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runSql(database, statements) {
  const c = newClient(database);
  await c.connect();
  try { for (const s of statements) await c.query(s); } finally { await c.end(); }
}

/** All ```sql blocks of every skill: [{ skill, index, sql }] */
function skillSqlBlocks() {
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => {
    const md = fs.readFileSync(path.join(SKILLS_DIR, e.name, "SKILL.md"), "utf8");
    return [...md.matchAll(/```sql\r?\n([\s\S]*?)```/g)].map((m, index) => ({ skill: e.name, index, sql: m[1].trim() }));
  });
}

const DOCS_DDL = [
  `CREATE SCHEMA docs_demo`,
  `CREATE TYPE docs_demo.account_status AS ENUM ('new', 'active', 'closed')`,
  `CREATE TABLE docs_demo.accounts (id serial PRIMARY KEY, email text NOT NULL, status docs_demo.account_status NOT NULL DEFAULT 'new',
     balance numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0), CONSTRAINT accounts_email_key UNIQUE (email))`,
  `COMMENT ON TABLE docs_demo.accounts IS 'Customer accounts'`,
  `COMMENT ON COLUMN docs_demo.accounts.email IS 'Login e-mail, unique'`,
  `CREATE INDEX accounts_email_lower_idx ON docs_demo.accounts (lower(email))`,
  `CREATE TABLE docs_demo.payments (id serial PRIMARY KEY, account_id int NOT NULL REFERENCES docs_demo.accounts(id), amount numeric(12,2) NOT NULL)`,
  `CREATE TABLE docs_demo.events (id bigint NOT NULL, happened date NOT NULL, payload text) PARTITION BY RANGE (happened)`,
  `CREATE TABLE docs_demo.events_2026 PARTITION OF docs_demo.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`,
  `CREATE VIEW docs_demo.active_accounts AS SELECT id, email FROM docs_demo.accounts WHERE status = 'active'`,
  `COMMENT ON VIEW docs_demo.active_accounts IS 'Only active accounts'`,
  `CREATE MATERIALIZED VIEW docs_demo.account_totals AS SELECT account_id, sum(amount) AS total FROM docs_demo.payments GROUP BY 1`,
  `CREATE FUNCTION docs_demo.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.balance := NEW.balance; RETURN NEW; END $$`,
  `CREATE FUNCTION docs_demo.total_of(acc int) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT coalesce(sum(amount), 0) FROM docs_demo.payments WHERE account_id = acc $$`,
  `COMMENT ON FUNCTION docs_demo.total_of(int) IS 'Sum of payments of one account'`,
  `CREATE PROCEDURE docs_demo.close_account(acc int) LANGUAGE sql AS $$ UPDATE docs_demo.accounts SET status = 'closed' WHERE id = acc $$`,
  `CREATE TRIGGER accounts_touch BEFORE UPDATE ON docs_demo.accounts FOR EACH ROW EXECUTE FUNCTION docs_demo.touch()`,
];

const SALES_DDL = [
  `CREATE EXTENSION IF NOT EXISTS pg_stat_statements`,
  `CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL)`,
  `CREATE TABLE orders (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id), amount numeric(10,2) NOT NULL, note text)`,
  `INSERT INTO customers (name) SELECT 'c' || g FROM generate_series(1, 50) g`,
  `INSERT INTO orders (customer_id, amount, note) SELECT 1 + (g % 50), g, 'n' || g FROM generate_series(1, 20000) g`,
  `ANALYZE`,
];

describe.skipIf(!HOST)("Skills on the PostgreSQL test database", () => {
  let client; let hasStatements = false;
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const query = (sql, params) => call("query", { sql, ...(params && { params }) });

  beforeAll(async () => {
    await runSql(ADMIN_DB, [`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, `CREATE DATABASE ${DB}`]);
    await runSql(DB, [...SALES_DDL.slice(0, 1).map(s => s), ...SALES_DDL.slice(1), ...DOCS_DDL].filter(Boolean));
    const c = newClient(DB); await c.connect();
    hasStatements = (await c.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'")).rowCount === 1;
    await c.end();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createMcpServer(getPool({ host: HOST, port: PORT, database: DB, ...SUPER, ssl: "false" }, "skills-test"), "skills-test", "127.0.0.1");
    client = new Client({ name: "skills-it", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    for (const p of poolCache.values()) await p.end().catch(() => {});
    poolCache.clear();
    vi.restoreAllMocks();
    await runSql(ADMIN_DB, [`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
  }, 60_000);

  // ── Prompts through a real MCP client ───────────────────────────────────────
  describe("prompts", () => {
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();

    it("lists one prompt per skill directory", async () => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map(p => p.name)).toEqual(dirs);
      expect(prompts.map(p => p.name)).toEqual(PROMPTS.map(p => p.name));
      for (const p of prompts) expect(p.description.length).toBeGreaterThan(40);
    });

    it.each(dirs)("serves %s with its SKILL.md body", async (name) => {
      const md = fs.readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");
      const body = md.replace(/^---[\s\S]*?\n---\r?\n/, "").trim();
      const args = name === "pg-error-analysis" ? { error: "42P01 relation does not exist" } : {};
      const r = await client.getPrompt({ name, arguments: args });
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0].role).toBe("user");
      expect(r.messages[0].content.text.startsWith(body)).toBe(true);
    });

    it("appends supplied arguments as an Input section and enforces required ones", async () => {
      const r = await client.getPrompt({ name: "pg-document", arguments: { schema: "docs_demo" } });
      expect(r.messages[0].content.text).toMatch(/## Input\s+- schema: docs_demo$/);
      await expect(client.getPrompt({ name: "pg-error-analysis", arguments: {} })).rejects.toThrow(/error/);
      await expect(client.getPrompt({ name: "no-such-skill" })).rejects.toThrow();
    });
  });

  // ── Every SQL block of every skill runs read-only on the test database ──────
  describe("SQL blocks of all skills", () => {
    const blocks = skillSqlBlocks();

    it("finds SQL in the skills", () => {
      expect(new Set(blocks.map(b => b.skill))).toEqual(new Set(["pg-activity", "pg-document", "pg-locks-waits", "pg-top-sessions"]));
    });

    it.each(blocks.map(b => [`${b.skill} #${b.index + 1}`, b]))("%s runs through the query tool (read-only, one statement)", async (_n, b) => {
      expect(b.sql).toMatch(/^(SELECT|WITH)\b/i);
      const r = await query(b.sql, /\$1\b/.test(b.sql) ? ["public"] : undefined);
      expect(r.isError, text(r)).toBeFalsy();
      expect(text(r).length).toBeGreaterThan(0);
    });
  });

  // ── pg-document ─────────────────────────────────────────────────────────────
  describe("pg-document documents a sample schema", () => {
    const docBlocks = skillSqlBlocks().filter(b => b.skill === "pg-document");
    const run = async (i, schema = "docs_demo") => text(await query(docBlocks[i].sql, [schema]));

    it("tables with comment, kind; partitions are folded into their parent", async () => {
      const t = await run(0);
      expect(t).toMatch(/accounts[^\n]*table[^\n]*Customer accounts/);
      expect(t).toMatch(/events[^\n]*partitioned/);
      expect(t).toContain("payments");
      expect(t).not.toContain("events_2026");
    });

    it("columns with types, defaults, nullability and comments", async () => {
      const t = await run(1);
      expect(t).toMatch(/email[^\n]*text[^\n]*Login e-mail, unique/);
      expect(t).toContain("numeric(12,2)");
      expect(t).toContain("docs_demo.account_status");
      expect(t).toMatch(/nextval\('docs_demo\.accounts_id_seq'/);
    });

    it("constraints (pk, unique, fk, check) and only non-constraint indexes", async () => {
      const c = await run(2);
      for (const name of ["accounts_pkey", "accounts_email_key", "payments_account_id_fkey", "accounts_balance_check"]) expect(c).toContain(name);
      expect(c).toMatch(/REFERENCES docs_demo\.accounts\(id\)/);
      const idx = await run(3);
      expect(idx).toContain("accounts_email_lower_idx");
      expect(idx).not.toContain("accounts_pkey");
      expect(idx).not.toContain("accounts_email_key");
    });

    it("views, functions/procedures, triggers, enums", async () => {
      const v = await run(4);
      expect(v).toMatch(/active_accounts[^\n]*view[^\n]*Only active accounts/);
      expect(v).toMatch(/account_totals[^\n]*materialized/);
      const f = await run(5);
      expect(f).toMatch(/total_of[^\n]*function[^\n]*acc integer[^\n]*numeric[^\n]*sql[^\n]*Sum of payments/);
      expect(f).toMatch(/close_account[^\n]*procedure/);
      expect(await run(6)).toMatch(/accounts_touch[^\n]*BEFORE UPDATE ON docs_demo\.accounts/);
      expect(await run(7)).toMatch(/account_status[^\n]*new, active, closed/);
    });

    it("leaves out objects of extensions (pg_stat_statements view in public)", async () => {
      if (!hasStatements) return;
      const views = await run(4, "public");
      expect(views).not.toContain("pg_stat_statements");
      expect(await run(5, "public")).not.toContain("pg_stat_statements");
    });
  });

  // ── pg-locks-waits / pg-top-sessions / pg-activity on a real blocking chain ─
  describe("blocking chain", () => {
    let blocker; let waiter; let blockerPid; let waiterPid; let waiterDone;
    const adminDb = () => newClient(DB);

    beforeAll(async () => {
      blocker = newClient(DB, "skilltest-blocker"); await blocker.connect();
      waiter = newClient(DB, "skilltest-waiter"); await waiter.connect();
      blockerPid = (await blocker.query("SELECT pg_backend_pid() AS p")).rows[0].p;
      waiterPid = (await waiter.query("SELECT pg_backend_pid() AS p")).rows[0].p;
      await blocker.query("BEGIN");
      await blocker.query("UPDATE orders SET amount = amount WHERE id = 1");        // root blocker, then idle in transaction
      waiterDone = waiter.query("UPDATE orders SET amount = amount + 1 WHERE id = 1").catch(e => e); // blocks
      const probe = adminDb(); await probe.connect();
      try {
        for (let i = 0; i < 50; i++) {
          const { rows } = await probe.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [waiterPid]);
          if (rows.length) return;
          await sleep(100);
        }
        throw new Error("waiter never blocked");
      } finally { await probe.end(); }
    }, 30_000);

    afterAll(async () => {
      await blocker.query("ROLLBACK").catch(() => {});
      await waiterDone;
      await waiter.end().catch(() => {});
      await blocker.end().catch(() => {});
    });

    const block = (skill, i) => skillSqlBlocks().find(b => b.skill === skill && b.index === i).sql;

    it("pg-locks-waits step 2 shows root blocker and waiting session with blocked_by", async () => {
      const t = text(await query(block("pg-locks-waits", 0)));
      expect(t).toContain(String(blockerPid));
      expect(t).toContain(String(waiterPid));
      expect(t).toContain("skilltest-waiter");
      expect(t).toContain("idle in transaction");
      expect(t).toContain(`| [${blockerPid}] |`); // blocked_by of the waiter
      expect(t).toContain("| [] |");              // the root blocker is blocked by nobody
      expect(t).toContain("UPDATE orders");
    });

    it("pg-locks-waits step 3 lists the ungranted lock and the holder", async () => {
      const t = text(await query(block("pg-locks-waits", 1)));
      expect(t).toContain(String(waiterPid));
      expect(t).toMatch(/transactionid|tuple/);
      expect(t).toMatch(/false/); // granted = false
      expect(t).toContain("orders");
    });

    it("active_queries names the blocker of the waiting session", async () => {
      const t = text(await call("active_queries"));
      expect(t).toContain(String(waiterPid));
      expect(t).toContain(String(blockerPid));
    });

    it("pg-top-sessions finds the idle-in-transaction session and the oldest transaction", async () => {
      const grouped = text(await query(block("pg-top-sessions", 0)));
      expect(grouped).toContain("skilltest-blocker");
      expect(grouped).toContain("idle in transaction");
      const xacts = text(await query(block("pg-top-sessions", 1)));
      expect(xacts).toContain(String(blockerPid));
      expect(xacts).toContain("skilltest-blocker");
    });

    it("pg-activity health query reports the idle-in-transaction session count", async () => {
      const r = await query(block("pg-activity", 0));
      expect(r.isError, text(r)).toBeFalsy();
      expect(text(r)).toMatch(/client_sessions/);
      expect(text(r)).toMatch(/max_connections/);
    });

    it("the skills' proposal is not executed by the tools: blocker is still there after all checks", async () => {
      const probe = adminDb(); await probe.connect();
      try {
        const { rows } = await probe.query("SELECT state FROM pg_stat_activity WHERE pid = $1", [blockerPid]);
        expect(rows[0].state).toBe("idle in transaction");
      } finally { await probe.end(); }
    });
  });

  // ── pg-activity: running statement ──────────────────────────────────────────
  describe("running statement", () => {
    it("active_queries shows a long-running statement with its query_id", async () => {
      const runner = newClient(DB, "skilltest-sleeper"); await runner.connect();
      const pid = (await runner.query("SELECT pg_backend_pid() AS p")).rows[0].p;
      const running = runner.query("SELECT pg_sleep(3), count(*) FROM orders").catch(() => {});
      try {
        await sleep(600);
        const t = text(await call("active_queries", { min_duration_seconds: 0.2 }));
        expect(t).toContain(String(pid));
        expect(t).toContain("pg_sleep");
        const only = text(await call("active_queries", { username: SUPER.user }));
        expect(only).toContain(String(pid));
      } finally { await running; await runner.end(); }
    }, 15_000);
  });

  // ── pg-top-sql / pg-sql-tuning with real statistics ─────────────────────────
  describe("pg_stat_statements workflows", () => {
    it("pg_stat_statements is available (docker compose postgres-test preloads it)", () => {
      // Set PG_TEST_NO_STATEMENTS=1 to run against a server without the extension (the workflow tests then no-op)
      if (!process.env.PG_TEST_NO_STATEMENTS) expect(hasStatements).toBe(true);
    });

    const SLOW = "SELECT c.name, sum(o.amount) FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.note LIKE $1 GROUP BY c.name";
    let queryId;

    beforeAll(async () => {
      if (!hasStatements) return;
      const c = newClient(DB, "skilltest-load"); await c.connect();
      try {
        for (let i = 0; i < 5; i++) await c.query(SLOW, ["n1%"]);
        queryId = (await c.query("SELECT queryid::text AS q FROM pg_stat_statements WHERE query LIKE 'SELECT c.name, sum%' LIMIT 1")).rows[0]?.q;
      } finally { await c.end(); }
    });

    it("top_queries (pg-top-sql) ranks the statement for every sort key and filters", async () => {
      if (!hasStatements) return;
      for (const order_by of ["total_time", "mean_time", "calls", "rows", "blocks_read", "temp_written"]) {
        const r = await call("top_queries", { order_by, limit: 5 });
        expect(r.isError, `${order_by}: ${text(r)}`).toBeFalsy();
      }
      const t = text(await call("top_queries", { order_by: "total_time", sql_text_like: "sum(o.amount)" }));
      expect(t).toContain("sum(o.amount)");
      expect(t).toContain(queryId);
      expect(t).not.toContain("pg_stat_activity"); // the tool's own catalog queries are filtered out
      expect(text(await call("top_queries", { user: "nobody-here" }))).not.toContain("sum(o.amount)");
      const bad = await call("top_queries", { order_by: "bogus" });
      expect(bad.isError).toBe(true);
    });

    it("pg-sql-tuning: statement with $1 → generic plan, then analyze, table_stats, index_health", async () => {
      if (!hasStatements) return;
      const statement = text(await call("top_queries", { sql_text_like: "sum(o.amount)" }));
      expect(statement).toContain("$1");
      const generic = text(await call("explain_query", { sql: SLOW, generic_plan: true }));
      expect(generic).toMatch(/Seq Scan on orders/);        // no index on note → the plan symptom of the tuning checklist
      expect(generic).toMatch(/Filter: \(?o?\.?note/);
      const actual = text(await call("explain_query", { sql: SLOW, params: ["n1%"], analyze: true }));
      expect(actual).toMatch(/Rows Removed by Filter/);
      expect(actual).toMatch(/Buffers:/);
      expect(text(await call("table_stats", { table: "orders" }))).toMatch(/n_distinct|dead|seq_scan|orders/);
      expect(text(await call("index_health"))).toBeTruthy();
    });

    it("pg-sql-tuning verify step: an index changes the plan", async () => {
      if (!hasStatements) return;
      await runSql(DB, [`CREATE INDEX orders_note_idx ON orders (note text_pattern_ops)`, `ANALYZE orders`]);
      const after = text(await call("explain_query", { sql: "SELECT id FROM orders WHERE note LIKE 'n1999%'" }));
      expect(after).toMatch(/Index Scan|Bitmap/);
      expect(after).toContain("orders_note_idx");
    });

    it("pg-activity: top_queries and performance_overview answer on a database with statistics", async () => {
      const ov = await call("performance_overview");
      expect(ov.isError).toBeFalsy();
      const top = await call("top_queries", { order_by: "total_time", limit: 10 });
      expect(top.isError).toBeFalsy();
      if (!hasStatements) expect(text(top)).toMatch(/pg_stat_statements is not installed/);
    });
  });
});
