import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { makeReq, makeRes } from "./helpers.js";

// ── Hoisted shared state (available inside vi.mock factories) ─────────────────
const { capturedHandlers, mockTransport } = vi.hoisted(() => {
  const capturedHandlers = {};
  const mockTransport = { handleRequest: vi.fn().mockResolvedValue(undefined) };
  return { capturedHandlers, mockTransport };
});

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock("pg", () => ({
  default: { Pool: vi.fn(function() { return { query: vi.fn(), end: vi.fn() }; }) },
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, randomUUID: vi.fn(() => "test-session-id") };
});

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => {
  const Server = vi.fn(function() {
    return {
      setRequestHandler: vi.fn((schema, handler) => { capturedHandlers[schema] = handler; }),
      connect: vi.fn().mockResolvedValue(undefined),
    };
  });
  return { Server };
});

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: vi.fn(function() { return mockTransport; }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: "LIST_TOOLS",
  CallToolRequestSchema: "CALL_TOOL",
}));

vi.mock("../lib.js", () => ({
  readFileEnv: vi.fn(),
  buildPgSsl: vi.fn(() => false),
  getAuthToken: vi.fn(() => ""),
  checkAuth: vi.fn().mockResolvedValue({ ok: true, name: "admin", connection: null }),
  checkAdminAuth: vi.fn(() => true),
  handleAdminRequest: vi.fn().mockResolvedValue(undefined),
  log: vi.fn(),
  isLogEnabled: vi.fn(() => false),
  getLogLevel: vi.fn(() => "info"),
  getClientIp: vi.fn(() => "10.0.0.1"),
}));

import { handleRequest, createMcpServer, getPool, applicationName, poolCache, sessions } from "../index.js";
import { checkAuth, handleAdminRequest, log, isLogEnabled } from "../lib.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ── handleRequest ─────────────────────────────────────────────────────────────
describe("handleRequest", () => {
  afterEach(() => {
    vi.mocked(checkAuth).mockResolvedValue({ ok: true, name: "admin", connection: null });
    vi.mocked(handleAdminRequest).mockResolvedValue(undefined);
    mockTransport.handleRequest.mockClear();
    delete process.env.TLS_ENABLED;
  });

  afterAll(async () => {
    // Clear the pool cache to close any open pools
    for (const p of poolCache.values()) {
      if (p && typeof p.end === "function") {
        await p.end();
      }
    }
    poolCache.clear();
    sessions.clear();
  });

  it("GET /health returns 200 + JSON (TLS_ENABLED=false → tls:false)", async () => {
    process.env.TLS_ENABLED = "false";
    const req = makeReq("GET", "/health");
    const res = makeRes();
    await handleRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "application/json" }));
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ status: "ok", tls: false });
  });

  it("GET /health returns tls:false when TLS_ENABLED is unset (default)", async () => {
    delete process.env.TLS_ENABLED;
    const req = makeReq("GET", "/health");
    const res = makeRes();
    await handleRequest(req, res);
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ tls: false });
  });

  it("/admin/tokens delegates to handleAdminRequest", async () => {
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleRequest(req, res);
    expect(vi.mocked(handleAdminRequest)).toHaveBeenCalledWith(req, res, expect.any(Object));
  });

  it("/admin/tokens/5 also delegates to handleAdminRequest", async () => {
    const req = makeReq("DELETE", "/admin/tokens/5");
    const res = makeRes();
    await handleRequest(req, res);
    expect(vi.mocked(handleAdminRequest)).toHaveBeenCalledWith(req, res, expect.any(Object));
  });

  it("/mcp does not call transport when checkAuth returns { ok: false }", async () => {
    vi.mocked(checkAuth).mockResolvedValueOnce({ ok: false });
    const req = makeReq("POST", "/mcp");
    const res = makeRes();
    await handleRequest(req, res);
    expect(mockTransport.handleRequest).not.toHaveBeenCalled();
  });

  it("/mcp creates a new session and calls transport.handleRequest on successful auth", async () => {
    vi.mocked(checkAuth).mockResolvedValueOnce({ ok: true, name: "test-user", connection: null });
    const req = makeReq("POST", "/mcp");
    const res = makeRes();
    await handleRequest(req, res);
    expect(mockTransport.handleRequest).toHaveBeenCalledWith(req, res);
  });

  it("/mcp opens the database pool with the token name in application_name", async () => {
    const { default: pg } = await import("pg");
    vi.mocked(checkAuth).mockResolvedValueOnce({ ok: true, name: "session-token", connection: { host: "tokhost" } });
    await handleRequest(makeReq("POST", "/mcp"), makeRes());
    expect(pg.Pool).toHaveBeenLastCalledWith(expect.objectContaining({ host: "tokhost", application_name: "pg-mcp-server:session-token" }));
  });

  it("deleting a token closes its pool", async () => {
    const p = getPool(null, "doomed");
    await handleRequest(makeReq("DELETE", "/admin/tokens/9"), makeRes());
    const { onDelete } = vi.mocked(handleAdminRequest).mock.calls.at(-1)[2];
    p.end.mockResolvedValue(undefined);
    onDelete({ name: "doomed", connection: null });
    expect(p.end).toHaveBeenCalled();
    expect(getPool(null, "doomed")).not.toBe(p);
  });

  it("/mcp logs session start and stop, keeping the previous onclose handler", async () => {
    vi.mocked(checkAuth).mockResolvedValueOnce({ ok: true, name: "test-user", connection: null });
    vi.mocked(log).mockClear();
    await handleRequest(makeReq("POST", "/mcp"), makeRes());
    const opts = vi.mocked(StreamableHTTPServerTransport).mock.calls.at(-1)[0];
    const prevOnClose = vi.fn();
    mockTransport.onclose = prevOnClose;

    opts.onsessioninitialized("sess-1");
    expect(sessions.has("sess-1")).toBe(true);
    expect(log).toHaveBeenCalledWith("info", "SESSION", expect.stringContaining('token="test-user" action="start" session="sess-1" ip="10.0.0.1"'));

    mockTransport.onclose();
    expect(sessions.has("sess-1")).toBe(false);
    expect(prevOnClose).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("info", "SESSION", expect.stringMatching(/action="stop" session="sess-1" .*duration=\d+s/));
    delete mockTransport.onclose;
  });

  it("unknown route returns 404", async () => {
    const req = makeReq("GET", "/unknown");
    const res = makeRes();
    await handleRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledWith("Not found");
  });
});

// ── getPool ───────────────────────────────────────────────────────────────────
describe("getPool", () => {
  it("returns a pool for the default connection when connection is null", async () => {
    const { default: pg } = await import("pg");
    const p = getPool(null, "admin");
    expect(p).toBeDefined();
    expect(pg.Pool).toHaveBeenLastCalledWith(expect.objectContaining({ application_name: "pg-mcp-server:admin" }));
    expect(getPool(null, "admin")).toBe(p);
  });

  it("returns a Pool instance for a connection config", () => {
    const conn = { host: "myhost", port: 5433, database: "mydb", user: "u", password: "p" };
    const p = getPool(conn);
    expect(p).toBeDefined();
  });

  it("returns the same cached Pool for the same connection config", () => {
    const conn = { host: "cachehost", database: "cachedb", user: "u", password: "p" };
    expect(getPool(conn)).toBe(getPool(conn));
  });

  it("returns different Pool instances for different connection configs", () => {
    const conn1 = { host: "host1", database: "db1", user: "u1", password: "p1" };
    const conn2 = { host: "host2", database: "db2", user: "u2", password: "p2" };
    expect(getPool(conn1)).not.toBe(getPool(conn2));
  });

  it("sets application_name to server and token name", async () => {
    const { default: pg } = await import("pg");
    getPool({ host: "apphost", database: "appdb" }, "reporting-team");
    expect(pg.Pool).toHaveBeenLastCalledWith(expect.objectContaining({ host: "apphost", application_name: "pg-mcp-server:reporting-team" }));
  });

  it("uses separate pools per token, also for the same connection", () => {
    const conn = { host: "shared", database: "db" };
    expect(getPool(conn, "alice")).not.toBe(getPool(conn, "bob"));
    expect(getPool(null, "alice")).not.toBe(getPool(null, "bob"));
    expect(getPool(conn, "alice")).toBe(getPool(conn, "alice"));
  });

  it("applicationName replaces non-ASCII characters and keeps 63 bytes", () => {
    expect(applicationName("Jürgen")).toBe("pg-mcp-server:J?rgen");
    expect(applicationName("x".repeat(100))).toHaveLength(63);
  });
});

// ── createMcpServer – ListTools ───────────────────────────────────────────────
describe("createMcpServer – ListTools", () => {
  it("returns 12 tools", async () => {
    const mockPool = { query: vi.fn() };
    createMcpServer(mockPool);
    const result = await capturedHandlers["LIST_TOOLS"]({});
    expect(result.tools).toHaveLength(12);
    const names = result.tools.map(t => t.name);
    expect(names).toContain("query");
    expect(names).toContain("execute");
    expect(names).toContain("list_tables");
    expect(names).toContain("describe_table");
    expect(names).toContain("list_schemas");
    expect(names).toContain("test_connection");
    for (const n of ["explain_query", "top_queries", "table_stats", "index_health", "active_queries", "performance_overview"]) {
      expect(names).toContain(n);
    }
  });

  it("each tool has name, description and inputSchema", async () => {
    const mockPool = { query: vi.fn() };
    createMcpServer(mockPool);
    const result = await capturedHandlers["LIST_TOOLS"]({});
    for (const tool of result.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

// ── createMcpServer – CallTool ────────────────────────────────────────────────
describe("createMcpServer – CallTool", () => {
  let mockPool;
  let mockClient;

  beforeEach(() => {
    mockClient = { query: vi.fn(), release: vi.fn() };
    mockPool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(mockClient) };
    createMcpServer(mockPool);
  });

  const call = (name, args = {}) =>
    capturedHandlers["CALL_TOOL"]({ params: { name, arguments: args } });

  // ── test_connection ─────────────────────────────────────────────────────────
  it("test_connection returns a success message with SSL info", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ version: "PostgreSQL 17", current_database: "testdb", current_user: "admin", now: "2025-01-01T00:00:00Z", ssl: true }],
    });
    const result = await call("test_connection");
    expect(result.content[0].text).toContain("Connection successful");
    expect(result.content[0].text).toContain("testdb");
    expect(result.content[0].text).toContain("encrypted");
    expect(result.isError).toBeUndefined();
  });

  it("test_connection shows 'unencrypted' when ssl=false", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ version: "PG 17", current_database: "db", current_user: "u", now: "now", ssl: false }],
    });
    const result = await call("test_connection");
    expect(result.content[0].text).toContain("unencrypted");
  });

  it("test_connection falls back to a simpler query when ssl column is missing", async () => {
    mockPool.query
      .mockRejectedValueOnce(new Error("column ssl does not exist"))
      .mockResolvedValueOnce({
        rows: [{ version: "PG 17", current_database: "db", current_user: "u", now: "now" }],
      });
    const result = await call("test_connection");
    expect(result.content[0].text).toContain("Connection successful");
    expect(result.content[0].text).toContain("unknown"); // ssl status unknown
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  // ── list_schemas ────────────────────────────────────────────────────────────
  it("list_schemas returns schema names", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ schema_name: "public" }, { schema_name: "myschema" }],
    });
    const result = await call("list_schemas");
    expect(result.content[0].text).toContain("public");
    expect(result.content[0].text).toContain("myschema");
  });

  // ── list_tables ─────────────────────────────────────────────────────────────
  it("list_tables returns tables for the given schema", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { table_name: "users", table_type: "BASE TABLE" },
        { table_name: "v_active", table_type: "VIEW" },
      ],
    });
    const result = await call("list_tables", { schema: "myschema" });
    const [, params] = mockPool.query.mock.calls[0];
    expect(params).toContain("myschema");
    expect(result.content[0].text).toContain("users");
    expect(result.content[0].text).toContain("VIEW");
  });

  it("list_tables uses 'public' as the default schema", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ table_name: "orders", table_type: "BASE TABLE" }],
    });
    await call("list_tables");
    const [, params] = mockPool.query.mock.calls[0];
    expect(params).toContain("public");
  });

  it("list_tables returns a notice when no tables exist", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await call("list_tables", { schema: "empty" });
    expect(result.content[0].text).toContain("No tables");
    expect(result.content[0].text).toContain("empty");
  });

  // ── describe_table ──────────────────────────────────────────────────────────
  it("describe_table returns column information", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { column_name: "id", data_type: "integer", character_maximum_length: null, is_nullable: "NO", column_default: null, key: "PK" },
        { column_name: "name", data_type: "character varying", character_maximum_length: 255, is_nullable: "YES", column_default: null, key: "" },
      ],
    });
    const result = await call("describe_table", { table: "users", schema: "public" });
    const text = result.content[0].text;
    expect(text).toContain("id");
    expect(text).toContain("integer");
    expect(text).toContain("PK");
    expect(text).toContain("character varying(255)");
  });

  it("describe_table returns 'not found' when the table does not exist", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await call("describe_table", { table: "nonexistent" });
    expect(result.content[0].text).toContain("not found");
  });

  // ── query ────────────────────────────────────────────────────────────────────
  it("query returns formatted rows", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ id: 1, email: "a@example.com" }, { id: 2, email: "b@example.com" }] })
      .mockResolvedValueOnce(undefined);
    // noinspection SqlNoDataSourceInspection
    const result = await call("query", { sql: "SELECT id, email FROM users" });
    const text = result.content[0].text;
    expect(text).toContain("id | email");
    expect(text).toContain("a@example.com");
    expect(text).toContain("(2 rows)");
  });

  it("query renders json/jsonb values as JSON instead of [object Object]", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan", "Total Cost": 3588 } }] }] })
      .mockResolvedValueOnce(undefined);
    const result = await call("query", { sql: "EXPLAIN (FORMAT JSON) SELECT 1" });
    const text = result.content[0].text;
    expect(text).not.toContain("[object Object]");
    expect(text).toContain('[{"Plan":{"Node Type":"Seq Scan","Total Cost":3588}}]');
  });

  it("query keeps dates and null values readable", async () => {
    const d = new Date("2026-09-25T10:00:00Z");
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ created_at: d, note: null, tags: ["a", "b"] }] })
      .mockResolvedValueOnce(undefined);
    const text = (await call("query", { sql: "SELECT created_at, note, tags FROM t" })).content[0].text;
    expect(text).toContain(`${String(d)} |  | ["a","b"]`);
  });

  it("query logs SQL text only at debug level", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    vi.mocked(log).mockClear();
    await call("query", { sql: "SELECT 'secret'" });
    const infoLine = vi.mocked(log).mock.calls.find(c => c[1] === "MCP")[2];
    expect(infoLine).toContain('action="query"');
    expect(infoLine).not.toContain("secret");
    expect(infoLine).toContain("15 chars");

    vi.mocked(isLogEnabled).mockReturnValueOnce(true);
    vi.mocked(log).mockClear();
    await call("query", { sql: "SELECT 'secret'" });
    expect(vi.mocked(log).mock.calls.find(c => c[1] === "MCP")[2]).toContain("SELECT 'secret'");
  });

  it("query passes parameters to pool.query", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })
      .mockResolvedValueOnce(undefined);
    // noinspection SqlNoDataSourceInspection
    await call("query", { sql: "SELECT id FROM users WHERE id = $1", params: [5] });
    // noinspection SqlNoDataSourceInspection
    expect(mockClient.query).toHaveBeenCalledWith({ text: "SELECT id FROM users WHERE id = $1", values: [5], queryMode: "extended" });
  });

  it("query uses the extended protocol so a single call cannot run several statements", async () => {
    mockClient.query.mockResolvedValue({ rows: [] });
    await call("query", { sql: "COMMIT; DROP TABLE t" });
    expect(mockClient.query).toHaveBeenNthCalledWith(1, "BEGIN READ ONLY");
    expect(mockClient.query).toHaveBeenNthCalledWith(2, { text: "COMMIT; DROP TABLE t", values: [], queryMode: "extended" });
  });

  it("query returns a notice for 0 rows", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);
    const result = await call("query", { sql: "SELECT 1 WHERE false" });
    expect(result.content[0].text).toBe("Query returned 0 rows.");
  });

  it("query limits output to 200 rows with a note", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ n: i }));
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce(undefined);
    // noinspection SqlNoDataSourceInspection
    const result = await call("query", { sql: "SELECT n FROM t" });
    expect(result.content[0].text).toContain("showing 200 of 201");
  });

  // ── execute ──────────────────────────────────────────────────────────────────
  it("execute returns the number of affected rows", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce(undefined);
    // noinspection SqlNoDataSourceInspection
    const result = await call("execute", { sql: "DELETE FROM users WHERE active = false" });
    expect(result.content[0].text).toContain("Rows affected: 3");
    expect(result.content[0].text).toContain("executed");
  });

  it("execute returns rowCount=0 when rowCount is null", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: null })
      .mockResolvedValueOnce(undefined);
    const result = await call("execute", { sql: "TRUNCATE logs" });
    expect(result.content[0].text).toContain("Rows affected: 0");
  });

  // ── explain_query ────────────────────────────────────────────────────────────
  it("explain_query runs EXPLAIN in a read-only transaction and always rolls back", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ "QUERY PLAN": "Seq Scan on t  (cost=0.00..1.01 rows=1 width=4)" }, { "QUERY PLAN": "  Filter: (id = 1)" }] })
      .mockResolvedValueOnce(undefined);
    const result = await call("explain_query", { sql: "SELECT * FROM t WHERE id = $1;", params: [1] });
    expect(mockClient.query).toHaveBeenNthCalledWith(1, "BEGIN READ ONLY");
    expect(mockClient.query).toHaveBeenNthCalledWith(2, {
      text: "EXPLAIN (ANALYZE false, BUFFERS false, VERBOSE false, FORMAT TEXT) SELECT * FROM t WHERE id = $1",
      values: [1],
      queryMode: "extended",
    });
    expect(mockClient.query).toHaveBeenNthCalledWith(3, "ROLLBACK");
    expect(mockClient.release).toHaveBeenCalled();
    expect(result.content[0].text).toBe("Seq Scan on t  (cost=0.00..1.01 rows=1 width=4)\n  Filter: (id = 1)");
  });

  it("explain_query enables BUFFERS with analyze and renders JSON plans", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }] })
      .mockResolvedValueOnce(undefined);
    const result = await call("explain_query", { sql: "SELECT 1", analyze: true, verbose: true, format: "json" });
    expect(mockClient.query.mock.calls[1][0].text).toBe("EXPLAIN (ANALYZE true, BUFFERS true, VERBOSE true, FORMAT JSON) SELECT 1");
    expect(JSON.parse(result.content[0].text)).toEqual([{ Plan: { "Node Type": "Result" } }]);
  });

  it("explain_query ignores non-boolean option values", async () => {
    mockClient.query.mockResolvedValue({ rows: [{ "QUERY PLAN": "Result" }] });
    await call("explain_query", { sql: "SELECT 1", buffers: "true) DROP", format: "xml" });
    expect(mockClient.query.mock.calls[1][0].text).toBe("EXPLAIN (ANALYZE false, BUFFERS false, VERBOSE false, FORMAT TEXT) SELECT 1");
  });

  it("explain_query adds SETTINGS and GENERIC_PLAN options", async () => {
    mockClient.query.mockResolvedValue({ rows: [{ "QUERY PLAN": "Result" }] });
    await call("explain_query", { sql: "SELECT 1", settings: true, generic_plan: true });
    expect(mockClient.query).toHaveBeenNthCalledWith(2, "SAVEPOINT generic_plan");
    expect(mockClient.query.mock.calls[2][0].text)
      .toBe("EXPLAIN (ANALYZE false, BUFFERS false, VERBOSE false, SETTINGS true, GENERIC_PLAN true, FORMAT TEXT) SELECT 1");
  });

  it("explain_query retries a generic plan with unbound placeholders via the simple protocol", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)                                   // BEGIN READ ONLY
      .mockResolvedValueOnce(undefined)                                   // SAVEPOINT
      .mockRejectedValueOnce(new Error('bind message supplies 0 parameters, but prepared statement "" requires 1'))
      .mockResolvedValueOnce(undefined)                                   // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce({ rows: [{ "QUERY PLAN": "Index Scan using t_pkey on t" }] })
      .mockResolvedValueOnce(undefined);                                  // ROLLBACK
    const result = await call("explain_query", { sql: "SELECT * FROM t WHERE id = $1", generic_plan: true });
    expect(mockClient.query).toHaveBeenNthCalledWith(4, "ROLLBACK TO SAVEPOINT generic_plan");
    expect(mockClient.query).toHaveBeenNthCalledWith(5,
      "EXPLAIN (ANALYZE false, BUFFERS false, VERBOSE false, GENERIC_PLAN true, FORMAT TEXT) SELECT * FROM t WHERE id = $1");
    expect(mockClient.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(result.content[0].text).toBe("Index Scan using t_pkey on t");
  });

  it("explain_query does not fall back to the simple protocol for other errors", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cannot insert multiple commands into a prepared statement"))
      .mockResolvedValueOnce(undefined);
    const result = await call("explain_query", { sql: "SELECT 1; COMMIT; DROP TABLE t", generic_plan: true });
    expect(result.isError).toBe(true);
    expect(mockClient.query).toHaveBeenCalledTimes(4);
    expect(mockClient.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("explain_query rejects generic_plan together with analyze or params", async () => {
    for (const extra of [{ analyze: true }, { params: [1] }]) {
      const result = await call("explain_query", { sql: "SELECT $1", generic_plan: true, ...extra });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("generic_plan cannot be combined");
    }
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it("explain_query rolls back and reports errors", async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cannot execute DELETE in a read-only transaction"))
      .mockResolvedValueOnce(undefined);
    const result = await call("explain_query", { sql: "DELETE FROM t", analyze: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("read-only transaction");
    expect(mockClient.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mockClient.release).toHaveBeenCalled();
  });

  // ── top_queries ──────────────────────────────────────────────────────────────
  it("top_queries explains how to enable pg_stat_statements when missing", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ version: 180000, schema: null }] });
    const result = await call("top_queries");
    expect(result.content[0].text).toContain("CREATE EXTENSION pg_stat_statements");
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it("top_queries uses *_exec_time columns on PG13+ and the extension schema", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ version: 170002, schema: "ext" }] })
      .mockResolvedValueOnce({ rows: [{ queryid: "42", calls: 5, total_ms: "12.0", query: "SELECT $1" }] })
      .mockResolvedValueOnce({ rows: [{ stats_reset: "2026-09-01 10:00", dealloc: 0 }] });
    const result = await call("top_queries", { order_by: "calls", limit: 500 });
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain("total_exec_time");
    expect(sql).toContain("FROM ext.pg_stat_statements");
    expect(sql).toContain("ORDER BY calls DESC");
    expect(sql).toContain("NOT LIKE '%/* pg-mcp-server:perf */%'");
    expect(params).toEqual([100, null, null]);
    expect(mockPool.query.mock.calls[2][0]).toContain("FROM ext.pg_stat_statements_info");
    const text = result.content[0].text;
    expect(text).toContain("Top statements by calls since 2026-09-01 10:00");
    expect(text).toContain("42 | 5 | 12.0 | SELECT $1");
    expect(text).not.toContain("evicted");
  });

  it("top_queries passes text and user filters and reports evicted entries", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ version: 180000, schema: "public" }] })
      .mockResolvedValueOnce({ rows: [{ queryid: "1", query: "SELECT * FROM orders" }] })
      .mockResolvedValueOnce({ rows: [{ stats_reset: null, dealloc: 17 }] });
    const result = await call("top_queries", { sql_text_like: "orders", user: "app" });
    expect(mockPool.query.mock.calls[1][1]).toEqual([10, "orders", "app"]);
    expect(result.content[0].text).toContain("17 entries were evicted");
  });

  it("top_queries tolerates a missing pg_stat_statements_info view", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ version: 160000, schema: "public" }] })
      .mockResolvedValueOnce({ rows: [{ queryid: "1", query: "SELECT 1" }] })
      .mockRejectedValueOnce(new Error('relation "public.pg_stat_statements_info" does not exist'));
    const result = await call("top_queries");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Top statements by total_time:");
  });

  it("top_queries notes hidden query text of other roles", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ version: 180000, schema: "public" }] })
      .mockResolvedValueOnce({ rows: [{ queryid: null, query: "<insufficient privilege>" }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await call("top_queries");
    expect(result.content[0].text).toContain("GRANT pg_read_all_stats");
  });

  it("top_queries uses total_time columns before PG13", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ version: 120000, schema: "public" }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await call("top_queries");
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain("round(s.total_time::numeric");
    expect(sql).not.toContain("exec_time");
    expect(params).toEqual([10, null, null]);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // no pg_stat_statements_info before PG14
    expect(result.content[0].text).toContain("No pg_stat_statements entries match");
  });

  it("top_queries rejects unknown order_by values", async () => {
    const result = await call("top_queries", { order_by: "1; DROP TABLE x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid order_by");
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  // ── table_stats ──────────────────────────────────────────────────────────────
  it("table_stats filters by schema and sorts by the chosen key", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ table_name: "public.t", total_size: "2 MB", seq_scan: 4 }] });
    const result = await call("table_stats", { schema: "public", order_by: "dead_rows", limit: 5 });
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("ORDER BY s.n_dead_tup DESC");
    expect(params).toEqual(["public", 5]);
    expect(result.content[0].text).toContain("public.t | 2 MB | 4");
  });

  it("table_stats defaults to all schemas, size order and 20 rows", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await call("table_stats");
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("ORDER BY pg_total_relation_size(s.relid) DESC");
    expect(params).toEqual([null, 20]);
    expect(result.content[0].text).toBe("No user tables found.");
  });

  it("table_stats with table shows details, warnings, indexes and column statistics", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{
        oid: 16384, table_name: "public.t", total_size: "2 MB", dead_pct: "23.1",
        modified_since_analyze: "3000", autoanalyze_threshold: "1050",
        last_analyze: "2026-09-25 19:47", last_autoanalyze: null,
      }] })
      .mockResolvedValueOnce({ rows: [
        { index_name: "t_pkey", size: "312 kB", kind: "primary", status: "", definition: "USING btree (id)" },
        { index_name: "t_bad", size: "8 kB", kind: "", status: "INVALID", definition: "USING btree (v)" },
      ] })
      .mockResolvedValueOnce({ rows: [{ column_name: "n", type: "integer", n_distinct: 10, most_common_vals: "{0,1,2}" }] });
    const result = await call("table_stats", { table: "t" });
    expect(mockPool.query.mock.calls[0][1]).toEqual(["public", "t"]);
    expect(mockPool.query.mock.calls[1][1]).toEqual([16384]);
    expect(mockPool.query.mock.calls[2][1]).toEqual([16384]);
    const text = result.content[0].text;
    expect(text).toContain("Table: public.t");
    expect(text).not.toMatch(/^oid/m);
    expect(text).toContain("Statistics are probably stale: 3000 rows modified");
    expect(text).toContain("23.1% dead rows");
    expect(text).toContain("Index t_bad is invalid");
    expect(text).toContain("t_pkey | 312 kB | primary |  | USING btree (id)");
    expect(text).toContain("n | integer | 10 | {0,1,2}");
  });

  it("table_stats detail warns when a table was never analyzed", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ oid: 1, table_name: "s.t", last_analyze: null, last_autoanalyze: null, dead_pct: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ column_name: "id" }] });
    const text = (await call("table_stats", { table: "t", schema: "s" })).content[0].text;
    expect(mockPool.query.mock.calls[0][1]).toEqual(["s", "t"]);
    expect(text).toContain("Never analyzed");
    expect(text).toMatch(/Indexes:\n\(none\)/);
  });

  it("table_stats detail reports unknown tables", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await call("table_stats", { table: "nope" });
    expect(result.content[0].text).toBe('Table "public.nope" not found.');
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it("performance tool queries carry the perf tag right after SELECT", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await call("table_stats");
    expect(mockPool.query.mock.calls[0][0]).toMatch(/^SELECT \/\* pg-mcp-server:perf \*\/ s\.schemaname/);
  });

  it("performance tools add a privilege hint to permission errors", async () => {
    mockPool.query.mockRejectedValueOnce(new Error("permission denied for function pg_ls_waldir"));
    const result = await call("performance_overview");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GRANT pg_monitor TO <user>");
  });

  it("other tools do not add the privilege hint", async () => {
    mockPool.query.mockRejectedValueOnce(new Error("permission denied for schema secret"));
    const result = await call("list_schemas");
    expect(result.content[0].text).not.toContain("pg_monitor");
  });

  it("table_stats rejects unknown order_by values", async () => {
    const result = await call("table_stats", { order_by: "relname" });
    expect(result.isError).toBe(true);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  // ── index_health ─────────────────────────────────────────────────────────────
  it("index_health reports unused, duplicate and invalid indexes", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ table_name: "public.t", index_name: "t_v1", index_size: "592 kB", idx_scan: 0 }] })
      .mockResolvedValueOnce({ rows: [{ table_name: "public.t", indexes: "t_v1, t_v2", total_size: "1184 kB" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ stats_reset: "2026-09-01 10:00" }] });
    const result = await call("index_health", { schema: "public" });
    const text = result.content[0].text;
    expect(text).toContain("since 2026-09-01 10:00");
    expect(text).toContain("public.t | t_v1 | 592 kB | 0");
    expect(text).toContain("t_v1, t_v2");
    expect(text).toMatch(/Invalid indexes.*\n\(none\)/);
    for (const c of mockPool.query.mock.calls.slice(0, 3)) expect(c[1]).toEqual(["public"]);
  });

  // ── active_queries ───────────────────────────────────────────────────────────
  it("active_queries lists sessions blocked-first with a summary and wait events", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [
        { pid: 96, state: "active", wait: "Lock:relation", blocked_by: "95", query_id: "7", query: "SELECT count(*) FROM t" },
        { pid: 95, state: "idle in transaction", wait: "Client:ClientRead", blocked_by: "", query_id: "8", query: "LOCK t" },
      ] })
      .mockResolvedValueOnce({ rows: [{ wait: "Lock:relation", sessions: "1" }] })
      .mockResolvedValueOnce({ rows: [{ all_stats: true }] });
    const result = await call("active_queries", { min_duration_seconds: 30, username: "app", limit: 500 });
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(params).toEqual([30, "app", 100]);
    expect(sql).toContain("ORDER BY cardinality(pg_blocking_pids(a.pid)) > 0 DESC");
    expect(sql).toContain("to_jsonb(a) ->> 'query_id'");
    const text = result.content[0].text;
    expect(text).toContain("Sessions: 2 — 1 active, 1 idle in transaction, 1 blocked");
    expect(text).toContain("96 | active | Lock:relation | 95 | 7");
    expect(text).toMatch(/Wait events of active sessions \(snapshot\):\nwait \| sessions/);
    expect(text).not.toContain("only sessions of your own role");
  });

  it("active_queries reports when nothing matches and notes missing visibility", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ all_stats: false }] });
    const result = await call("active_queries", { min_duration_seconds: -5 });
    expect(mockPool.query.mock.calls[0][1]).toEqual([0, null, 50]);
    expect(result.content[0].text).toContain("No active sessions");
    expect(result.content[0].text).toContain("only sessions of your own role are visible");
  });

  // ── performance_overview ─────────────────────────────────────────────────────
  it("performance_overview shows database statistics and tuning settings", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ database: "db", cache_hit_pct: "99.12", deadlocks: 0, stats_reset: null }] })
      .mockResolvedValueOnce({ rows: [{ name: "shared_buffers", value: "128MB", source: "configuration file" }] });
    const result = await call("performance_overview");
    const text = result.content[0].text;
    expect(text).toContain("since database creation");
    expect(text).toMatch(/cache_hit_pct\s+: 99\.12/);
    expect(text).toContain("shared_buffers | 128MB | configuration file");
    expect(mockPool.query.mock.calls[1][1][0]).toContain("work_mem");
  });

  // ── Error handling ───────────────────────────────────────────────────────────
  it("unknown tool returns an isError response", async () => {
    const result = await call("nonexistent_tool");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("returns an isError response when pool.query throws", async () => {
    mockPool.query.mockRejectedValueOnce(new Error("DB connection lost"));
    const result = await call("list_schemas");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DB connection lost");
  });
});
