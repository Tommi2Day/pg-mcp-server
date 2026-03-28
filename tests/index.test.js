import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeReq, makeRes } from "./helpers.js";

// ── Hoisted shared state (available inside vi.mock factories) ─────────────────
const { capturedHandlers, mockTransport } = vi.hoisted(() => {
  const capturedHandlers = {};
  const mockTransport = { handleRequest: vi.fn().mockResolvedValue(undefined) };
  return { capturedHandlers, mockTransport };
});

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock("pg", () => ({
  default: { Pool: vi.fn(() => ({ query: vi.fn(), end: vi.fn() })) },
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn(() => ({
    setRequestHandler: vi.fn((schema, handler) => { capturedHandlers[schema] = handler; }),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: vi.fn(() => mockTransport),
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
  checkAuth: vi.fn().mockResolvedValue(true),
  handleAdminRequest: vi.fn().mockResolvedValue(undefined),
}));

import { handleRequest, initTokenTable, createMcpServer } from "../index.js";
import { checkAuth, handleAdminRequest } from "../lib.js";

// ── initTokenTable ────────────────────────────────────────────────────────────
describe("initTokenTable", () => {
  it("führt CREATE TABLE IF NOT EXISTS aus", async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({}) };
    await initTokenTable(mockPool);
    expect(mockPool.query).toHaveBeenCalledOnce();
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS mcp_auth_tokens");
    expect(sql).toContain("token_hash");
    expect(sql).toContain("SERIAL PRIMARY KEY");
  });
});

// ── handleRequest ─────────────────────────────────────────────────────────────
describe("handleRequest", () => {
  afterEach(() => {
    vi.mocked(checkAuth).mockResolvedValue(true);
    vi.mocked(handleAdminRequest).mockResolvedValue(undefined);
    mockTransport.handleRequest.mockClear();
    delete process.env.TLS_ENABLED;
  });

  it("GET /health gibt 200 + JSON zurück (TLS_ENABLED=false → tls:false)", async () => {
    process.env.TLS_ENABLED = "false";
    const req = makeReq("GET", "/health");
    const res = makeRes();
    await handleRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "application/json" }));
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ status: "ok", tls: false });
  });

  it("GET /health gibt tls:true wenn TLS_ENABLED nicht 'false'", async () => {
    delete process.env.TLS_ENABLED;
    const req = makeReq("GET", "/health");
    const res = makeRes();
    await handleRequest(req, res);
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ tls: true });
  });

  it("/admin/tokens delegiert an handleAdminRequest", async () => {
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleRequest(req, res);
    expect(vi.mocked(handleAdminRequest)).toHaveBeenCalledWith(undefined, req, res);
  });

  it("/admin/tokens/5 delegiert ebenfalls an handleAdminRequest", async () => {
    const req = makeReq("DELETE", "/admin/tokens/5");
    const res = makeRes();
    await handleRequest(req, res);
    expect(vi.mocked(handleAdminRequest)).toHaveBeenCalledWith(undefined, req, res);
  });

  it("/mcp gibt 401 zurück wenn checkAuth false zurückgibt", async () => {
    vi.mocked(checkAuth).mockResolvedValueOnce(false);
    const req = makeReq("POST", "/mcp");
    const res = makeRes();
    await handleRequest(req, res);
    expect(mockTransport.handleRequest).not.toHaveBeenCalled();
  });

  it("/mcp ruft transport.handleRequest auf bei erfolgreicher Auth", async () => {
    vi.mocked(checkAuth).mockResolvedValueOnce(true);
    const req = makeReq("POST", "/mcp");
    const res = makeRes();
    await handleRequest(req, res);
    expect(mockTransport.handleRequest).toHaveBeenCalledWith(req, res);
  });

  it("unbekannte Route gibt 404 zurück", async () => {
    const req = makeReq("GET", "/unknown");
    const res = makeRes();
    await handleRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledWith("Not found");
  });
});

// ── createMcpServer – ListTools ───────────────────────────────────────────────
describe("createMcpServer – ListTools", () => {
  it("gibt 6 Tools zurück", async () => {
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

  it("jedes Tool hat name, description und inputSchema", async () => {
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
  it("test_connection gibt erfolgreiche Meldung mit SSL-Info zurück", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ version: "PostgreSQL 17", current_database: "testdb", current_user: "admin", now: "2025-01-01T00:00:00Z", ssl: true }],
    });
    const result = await call("test_connection");
    expect(result.content[0].text).toContain("Connection successful");
    expect(result.content[0].text).toContain("testdb");
    expect(result.content[0].text).toContain("encrypted");
    expect(result.isError).toBeUndefined();
  });

  it("test_connection zeigt unencrypted wenn ssl=false", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ version: "PG 17", current_database: "db", current_user: "u", now: "now", ssl: false }],
    });
    const result = await call("test_connection");
    expect(result.content[0].text).toContain("unencrypted");
  });

  it("test_connection fällt auf Fallback-Query zurück wenn ssl-Spalte fehlt", async () => {
    mockPool.query
      .mockRejectedValueOnce(new Error("column ssl does not exist"))
      .mockResolvedValueOnce({
        rows: [{ version: "PG 17", current_database: "db", current_user: "u", now: "now" }],
      });
    const result = await call("test_connection");
    expect(result.content[0].text).toContain("Connection successful");
    expect(result.content[0].text).toContain("unknown"); // ssl unknown
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  // ── list_schemas ────────────────────────────────────────────────────────────
  it("list_schemas gibt Schemanamen zurück", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ schema_name: "public" }, { schema_name: "myschema" }],
    });
    const result = await call("list_schemas");
    expect(result.content[0].text).toContain("public");
    expect(result.content[0].text).toContain("myschema");
  });

  // ── list_tables ─────────────────────────────────────────────────────────────
  it("list_tables gibt Tabellen des angegebenen Schemas zurück", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { table_name: "users", table_type: "BASE TABLE" },
        { table_name: "v_active", table_type: "VIEW" },
      ],
    });
    const result = await call("list_tables", { schema: "myschema" });
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(params).toContain("myschema");
    expect(result.content[0].text).toContain("users");
    expect(result.content[0].text).toContain("VIEW");
  });

  it("list_tables verwendet 'public' als Standardschema", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ table_name: "orders", table_type: "BASE TABLE" }],
    });
    await call("list_tables");
    const [, params] = mockPool.query.mock.calls[0];
    expect(params).toContain("public");
  });

  it("list_tables gibt Hinweis zurück wenn keine Tabellen vorhanden", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await call("list_tables", { schema: "empty" });
    expect(result.content[0].text).toContain("No tables");
    expect(result.content[0].text).toContain("empty");
  });

  // ── describe_table ──────────────────────────────────────────────────────────
  it("describe_table gibt Spalteninformationen zurück", async () => {
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

  it("describe_table gibt 'not found' zurück wenn Tabelle nicht existiert", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await call("describe_table", { table: "nonexistent" });
    expect(result.content[0].text).toContain("not found");
  });

  // ── query ────────────────────────────────────────────────────────────────────
  it("query gibt formatierte Zeilen zurück", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, email: "a@example.com" }, { id: 2, email: "b@example.com" }],
    });
    const result = await call("query", { sql: "SELECT id, email FROM users" });
    const text = result.content[0].text;
    expect(text).toContain("id | email");
    expect(text).toContain("a@example.com");
    expect(text).toContain("(2 rows)");
  });

  it("query übergibt Parameter an pool.query", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    await call("query", { sql: "SELECT id FROM users WHERE id = $1", params: [5] });
    expect(mockPool.query).toHaveBeenCalledWith("SELECT id FROM users WHERE id = $1", [5]);
  });

  it("query gibt Hinweis zurück bei 0 Zeilen", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await call("query", { sql: "SELECT 1 WHERE false" });
    expect(result.content[0].text).toBe("Query returned 0 rows.");
  });

  it("query begrenzt Ausgabe auf 200 Zeilen mit Hinweis", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ n: i }));
    mockPool.query.mockResolvedValueOnce({ rows });
    const result = await call("query", { sql: "SELECT n FROM t" });
    expect(result.content[0].text).toContain("showing 200 of 201");
  });

  // ── execute ──────────────────────────────────────────────────────────────────
  it("execute gibt Anzahl betroffener Zeilen zurück", async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 3 });
    const result = await call("execute", { sql: "DELETE FROM users WHERE active = false" });
    expect(result.content[0].text).toContain("Rows affected: 3");
    expect(result.content[0].text).toContain("executed");
  });

  it("execute gibt rowCount=0 zurück wenn kein rowCount geliefert", async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: null });
    const result = await call("execute", { sql: "TRUNCATE logs" });
    expect(result.content[0].text).toContain("Rows affected: 0");
  });

  // ── Fehlerbehandlung ─────────────────────────────────────────────────────────
  it("unbekanntes Tool gibt isError-Antwort zurück", async () => {
    const result = await call("nonexistent_tool");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("gibt isError-Antwort zurück wenn pool.query wirft", async () => {
    mockPool.query.mockRejectedValueOnce(new Error("DB connection lost"));
    const result = await call("list_schemas");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DB connection lost");
  });
});
