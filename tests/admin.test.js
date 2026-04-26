import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleAdminRequest } from "../lib.js";
import { makeReq, makeRes, resBody } from "./helpers.js";

// ── Mock node:fs ──────────────────────────────────────────────────────────────
const { mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockReadFile:  vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { readFileSync: mockReadFile, writeFileSync: mockWriteFile },
}));

const ADMIN_TOKEN = "test-admin-token";

/** Build a token store structure. */
const makeStore = (tokens = [], next_id = tokens.length + 1) => ({ tokens, next_id });

/** Seed the mock file with a store. */
const seedStore = (store) => mockReadFile.mockReturnValueOnce(JSON.stringify(store));

/** Return the store that was written to the mock file. */
const writtenStore = () => JSON.parse(mockWriteFile.mock.calls[0][1]);

describe("handleAdminRequest", () => {
  beforeEach(() => {
    process.env.AUTH_TOKEN = ADMIN_TOKEN;
    // Default: file does not exist → empty store
    mockReadFile.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockWriteFile.mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.AUTH_TOKEN;
    vi.clearAllMocks();
  });

  // ── Auth guard ──────────────────────────────────────────────────────────────
  it("allows GET /admin/tokens when AUTH_TOKEN is not configured (auth disabled)", async () => {
    delete process.env.AUTH_TOKEN;
    seedStore(makeStore([{ id: 1, name: "t", token_hash: "h", active: true, created_at: "x", last_used_at: null, connection: null }]));
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });

  it("returns 401 for a wrong admin token", async () => {
    const req = makeReq("GET", "/admin/tokens", { headers: { authorization: "Bearer wrong" } });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  // ── GET /admin/tokens ───────────────────────────────────────────────────────
  it("GET lists all tokens without exposing token_hash", async () => {
    const tokens = [
      { id: 1, name: "claude", token_hash: "secret-hash", active: true,
        created_at: "2025-01-01T00:00:00Z", last_used_at: null, connection: null },
    ];
    seedStore(makeStore(tokens, 2));
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = resBody(res);
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].token_hash).toBeUndefined();
    expect(body.tokens[0].name).toBe("claude");
    expect(body.tokens[0].connection).toBeNull();
  });

  it("GET returns connection info when set", async () => {
    const conn = { host: "myhost", port: 5433, database: "mydb", user: "u", password: "p" };
    const tokens = [
      { id: 1, name: "tok", token_hash: "h", active: true,
        created_at: "2025-01-01T00:00:00Z", last_used_at: null, connection: conn },
    ];
    seedStore(makeStore(tokens, 2));
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(resBody(res).tokens[0].connection).toMatchObject(conn);
  });

  // ── POST /admin/tokens ──────────────────────────────────────────────────────
  it("POST creates a new token", async () => {
    seedStore(makeStore());
    const req = makeReq("POST", "/admin/tokens", { body: JSON.stringify({ name: "new-client" }) });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
    const body = resBody(res);
    expect(body.name).toBe("new-client");
    expect(body.id).toBe(1);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token_hash).toBeUndefined(); // never exposed
    expect(body.connection).toBeNull();
    // DB stores the hash, not the plaintext
    const saved = writtenStore();
    expect(saved.tokens[0].token_hash).toHaveLength(64);
    expect(saved.tokens[0].token_hash).not.toBe(body.token);
    expect(saved.next_id).toBe(2);
  });

  it("POST creates a new token with a connection", async () => {
    seedStore(makeStore());
    const connection = { host: "myhost", port: 5433, database: "mydb", user: "myuser", password: "secret" };
    const req = makeReq("POST", "/admin/tokens", {
      body: JSON.stringify({ name: "connected", connection }),
    });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
    const body = resBody(res);
    expect(body.connection).toMatchObject(connection);
    expect(writtenStore().tokens[0].connection).toMatchObject(connection);
  });

  it("POST returns 400 when name is missing", async () => {
    const req = makeReq("POST", "/admin/tokens", { body: JSON.stringify({}) });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("POST returns 400 when name is whitespace only", async () => {
    const req = makeReq("POST", "/admin/tokens", { body: JSON.stringify({ name: "   " }) });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  it("POST returns 400 when connection is not an object", async () => {
    const req = makeReq("POST", "/admin/tokens", {
      body: JSON.stringify({ name: "tok", connection: "invalid" }),
    });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  // ── PATCH /admin/tokens/:id ─────────────────────────────────────────────────
  it("PATCH updates name and active", async () => {
    const tokens = [
      { id: 3, name: "old", token_hash: "h", active: true,
        created_at: "2025-01-01T00:00:00Z", last_used_at: null, connection: null },
    ];
    seedStore(makeStore(tokens, 4));
    const req = makeReq("PATCH", "/admin/tokens/3", {
      body: JSON.stringify({ name: "renamed", active: false }),
    });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = resBody(res);
    expect(body.id).toBe(3);
    expect(body.name).toBe("renamed");
    expect(body.active).toBe(false);
    expect(body.token_hash).toBeUndefined();
  });

  it("PATCH sets a connection on an existing token", async () => {
    const tokens = [
      { id: 3, name: "tok", token_hash: "h", active: true,
        created_at: "2025-01-01T00:00:00Z", last_used_at: null, connection: null },
    ];
    seedStore(makeStore(tokens, 4));
    const conn = { host: "newhost", database: "newdb", user: "u", password: "p" };
    const req = makeReq("PATCH", "/admin/tokens/3", { body: JSON.stringify({ connection: conn }) });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = resBody(res);
    expect(body.connection).toMatchObject(conn);
    expect(writtenStore().tokens[0].connection).toMatchObject(conn);
  });

  it("PATCH clears a connection with null", async () => {
    const conn = { host: "h", database: "d", user: "u", password: "p" };
    const tokens = [
      { id: 3, name: "tok", token_hash: "h", active: true,
        created_at: "2025-01-01T00:00:00Z", last_used_at: null, connection: conn },
    ];
    seedStore(makeStore(tokens, 4));
    const req = makeReq("PATCH", "/admin/tokens/3", { body: JSON.stringify({ connection: null }) });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(resBody(res).connection).toBeNull();
    expect(writtenStore().tokens[0].connection).toBeNull();
  });

  it("PATCH returns 400 when no valid fields are provided", async () => {
    const req = makeReq("PATCH", "/admin/tokens/3", { body: JSON.stringify({}) });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("PATCH returns 404 when token is not found", async () => {
    seedStore(makeStore());
    const req = makeReq("PATCH", "/admin/tokens/99", { body: JSON.stringify({ name: "x" }) });
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  // ── DELETE /admin/tokens/:id ────────────────────────────────────────────────
  it("DELETE permanently removes a token", async () => {
    const tokens = [
      { id: 5, name: "tok", token_hash: "h", active: true,
        created_at: "2025-01-01T00:00:00Z", last_used_at: null, connection: null },
    ];
    seedStore(makeStore(tokens, 6));
    const req = makeReq("DELETE", "/admin/tokens/5");
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(resBody(res)).toEqual({ ok: true, id: 5 });
    expect(writtenStore().tokens).toHaveLength(0);
  });

  it("DELETE returns 404 when token is not found", async () => {
    seedStore(makeStore());
    const req = makeReq("DELETE", "/admin/tokens/99");
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  // ── Error handling ──────────────────────────────────────────────────────────
  it("returns 405 for a disallowed method", async () => {
    const req = makeReq("PUT", "/admin/tokens");
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
  });

  it("returns 500 on a file read error", async () => {
    mockReadFile.mockImplementation(() => { throw new Error("disk error"); });
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleAdminRequest(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(resBody(res)).toMatchObject({ error: "disk error" });
  });
});
