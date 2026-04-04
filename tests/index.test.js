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
  handleAdminRequest: vi.fn().mockResolvedValue(undefined),
}));

import { handleRequest, createMcpServer, getPool, poolCache, sessions, pool } from "../index.js";
import { checkAuth, handleAdminRequest } from "../lib.js";

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

    // Close the default pool if it was initialized
    if (pool && typeof pool.end === "function") {
      await pool.end();
    }
  });

  it("GET /health returns 200 + JSON (TLS_ENABLED=false → tls:false)", async () => {
    process.env.TLS_ENABLED = "false";
    const req = makeReq("GET", "/health");
    const res = makeRes();
    await handleRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "application/json" }));
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ status: "ok", tls: false });
  });

  it("GET /health returns tls:true when TLS_ENABLED is not 'false'", async () => {
    delete process.env.TLS_ENABLED;
    const req = makeReq("GET", "/health");
    const res = makeRes();
    await handleRequest(req, res);
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ tls: true });
  });

  it("GET /info returns version and db connection info without password", async () => {
    process.env.PG_HOST     = "dbhost";
    process.env.PG_PORT     = "5433";
    process.env.PG_DATABASE = "mydb";
    process.env.PG_USER     = "myuser";
    process.env.PG_PASSWORD = "secret";
    process.env.PG_SSL      = "true";
    const req = makeReq("GET", "/info");
    const res = makeRes();
    await handleRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "application/json" }));
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.version).toBeTruthy();
    expect(body.db).toEqual({ host: "dbhost", port: 5433, database: "mydb", user: "myuser", ssl: "true" });
    expect(body.db.password).toBeUndefined();
    delete process.env.PG_HOST;
    delete process.env.PG_PORT;
    delete process.env.PG_DATABASE;
    delete process.env.PG_USER;
    delete process.env.PG_PASSWORD;
    delete process.env.PG_SSL;
  });

  it("/admin/tokens delegates to handleAdminRequest", async () => {
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleRequest(req, res);
    expect(vi.mocked(handleAdminRequest)).toHaveBeenCalledWith(req, res);
  });

  it("/admin/tokens/5 also delegates to handleAdminRequest", async () => {
    const req = makeReq("DELETE", "/admin/tokens/5");
    const res = makeRes();
    await handleRequest(req, res);
    expect(vi.mocked(handleAdminRequest)).toHaveBeenCalledWith(req, res);
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
  it("returns the admin pool (undefined in tests) when connection is null", () => {
    expect(getPool(null)).toBeUndefined();
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
});

// ── createMcpServer – ListTools ───────────────────────────────────────────────
describe("createMcpServer – ListTools", () => {
  it("returns 6 tools", async () => {
    const mockPool = { query: vi.fn() };
    createMcpServer(mockPool);
    const result = await capturedHandlers["LIST_TOOLS"]({});
    expect(result.tools).toHaveLength(6);
    const names = result.tools.map(t => t.name);
    expect(names).toContain("query");
    expect(names).toContain("execute");
    expect(names).toContain("list_tables");
    expect(names).toContain("describe_table");
    expect(names).toContain("list_schemas");
    expect(names).toContain("test_connection");
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

  beforeEach(() => {
    mockPool = { query: vi.fn() };
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
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, email: "a@example.com" }, { id: 2, email: "b@example.com" }],
    });
    // noinspection SqlNoDataSourceInspection
    const result = await call("query", { sql: "SELECT id, email FROM users" });
    const text = result.content[0].text;
    expect(text).toContain("id | email");
    expect(text).toContain("a@example.com");
    expect(text).toContain("(2 rows)");
  });

  it("query passes parameters to pool.query", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    // noinspection SqlNoDataSourceInspection
    await call("query", { sql: "SELECT id FROM users WHERE id = $1", params: [5] });
    // noinspection SqlNoDataSourceInspection
    expect(mockPool.query).toHaveBeenCalledWith("SELECT id FROM users WHERE id = $1", [5]);
  });

  it("query returns a notice for 0 rows", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await call("query", { sql: "SELECT 1 WHERE false" });
    expect(result.content[0].text).toBe("Query returned 0 rows.");
  });

  it("query limits output to 200 rows with a note", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ n: i }));
    mockPool.query.mockResolvedValueOnce({ rows });
    // noinspection SqlNoDataSourceInspection
    const result = await call("query", { sql: "SELECT n FROM t" });
    expect(result.content[0].text).toContain("showing 200 of 201");
  });

  // ── execute ──────────────────────────────────────────────────────────────────
  it("execute returns the number of affected rows", async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 3 });
    // noinspection SqlNoDataSourceInspection
    const result = await call("execute", { sql: "DELETE FROM users WHERE active = false" });
    expect(result.content[0].text).toContain("Rows affected: 3");
    expect(result.content[0].text).toContain("executed");
  });

  it("execute returns rowCount=0 when rowCount is null", async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: null });
    const result = await call("execute", { sql: "TRUNCATE logs" });
    expect(result.content[0].text).toContain("Rows affected: 0");
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
