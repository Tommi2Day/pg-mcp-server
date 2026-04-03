import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import {
  hashToken,
  extractBearer,
  send401,
  readBody,
  buildPgSsl,
  getAuthToken,
  checkAuth,
  checkAdminAuth,
} from "../lib.js";
import { makeReq, makeRes, resBody } from "./helpers.js";

// ── Mock node:fs (for token store used by checkAuth) ──────────────────────────
const { mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockReadFile:  vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { readFileSync: mockReadFile, writeFileSync: mockWriteFile },
}));

// ── hashToken ─────────────────────────────────────────────────────────────────
describe("hashToken", () => {
  it("returns a 64-character hex string", () => {
    expect(hashToken("hello")).toHaveLength(64);
    expect(hashToken("hello")).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("matches node:crypto SHA-256", () => {
    const expected = crypto.createHash("sha256").update("test-token").digest("hex");
    expect(hashToken("test-token")).toBe(expected);
  });
});

// ── extractBearer ─────────────────────────────────────────────────────────────
describe("extractBearer", () => {
  it("extracts the token from a valid Bearer header", () => {
    expect(extractBearer({ headers: { authorization: "Bearer mytoken123" } })).toBe("mytoken123");
  });

  it("returns empty string when no Authorization header is present", () => {
    expect(extractBearer({ headers: {} })).toBe("");
  });

  it("returns empty string for non-Bearer schemes", () => {
    expect(extractBearer({ headers: { authorization: "Basic dXNlcjpwYXNz" } })).toBe("");
  });

  it("returns empty string for 'Bearer ' with no token", () => {
    expect(extractBearer({ headers: { authorization: "Bearer " } })).toBe("");
  });

  it("returns empty string when headers is undefined", () => {
    expect(extractBearer({})).toBe("");
  });
});

// ── send401 ───────────────────────────────────────────────────────────────────
describe("send401", () => {
  it("sets status 401 with WWW-Authenticate header", () => {
    const res = makeRes();
    send401(res);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.objectContaining({
      "WWW-Authenticate": 'Bearer realm="pg-mcp-server"',
      "Content-Type": "application/json",
    }));
  });

  it("writes a JSON error response", () => {
    const res = makeRes();
    send401(res);
    expect(resBody(res)).toEqual({ error: "Unauthorized" });
  });
});

// ── readBody ──────────────────────────────────────────────────────────────────
describe("readBody", () => {
  it("resolves with concatenated chunks", async () => {
    const req = new EventEmitter();
    const promise = readBody(req);
    req.emit("data", "hel");
    req.emit("data", "lo");
    req.emit("end");
    expect(await promise).toBe("hello");
  });

  it("resolves with empty string when no body", async () => {
    const req = new EventEmitter();
    const promise = readBody(req);
    req.emit("end");
    expect(await promise).toBe("");
  });

  it("rejects on stream error", async () => {
    const req = new EventEmitter();
    const promise = readBody(req);
    req.emit("error", new Error("connection reset"));
    await expect(promise).rejects.toThrow("connection reset");
  });
});

// ── buildPgSsl ────────────────────────────────────────────────────────────────
describe("buildPgSsl", () => {
  beforeEach(() => {
    delete process.env.PG_SSL;
    delete process.env.PG_SSL_CA_FILE;
    delete process.env.PG_SSL_CERT_FILE;
    delete process.env.PG_SSL_KEY_FILE;
  });

  it("returns false when PG_SSL is not set", () => {
    expect(buildPgSsl()).toBe(false);
  });

  it("returns false for PG_SSL=false", () => {
    process.env.PG_SSL = "false";
    expect(buildPgSsl()).toBe(false);
  });

  it("returns false for PG_SSL=0", () => {
    process.env.PG_SSL = "0";
    expect(buildPgSsl()).toBe(false);
  });

  it("returns false for PG_SSL=prefer (pg driver has no automatic fallback)", () => {
    process.env.PG_SSL = "prefer";
    expect(buildPgSsl()).toBe(false);
  });

  it("returns SSL config with rejectUnauthorized=false for PG_SSL=true", () => {
    process.env.PG_SSL = "true";
    expect(buildPgSsl()).toMatchObject({ rejectUnauthorized: false });
  });

  it("calls process.exit for PG_SSL=verify without PG_SSL_CA_FILE", () => {
    process.env.PG_SSL = "verify";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    expect(() => buildPgSsl()).toThrow("exit");
    exitSpy.mockRestore();
  });
});

// ── getAuthToken ──────────────────────────────────────────────────────────────
describe("getAuthToken", () => {
  afterEach(() => { delete process.env.AUTH_TOKEN; });

  it("returns empty string when AUTH_TOKEN is not set", () => {
    expect(getAuthToken()).toBe("");
  });

  it("returns the configured AUTH_TOKEN", () => {
    process.env.AUTH_TOKEN = "my-secret";
    expect(getAuthToken()).toBe("my-secret");
  });
});

// ── checkAdminAuth ────────────────────────────────────────────────────────────
describe("checkAdminAuth", () => {
  afterEach(() => { delete process.env.AUTH_TOKEN; });

  it("returns true when AUTH_TOKEN is not configured (auth disabled)", () => {
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    expect(checkAdminAuth(req, res)).toBe(true);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it("returns false with 401 for a wrong token", () => {
    process.env.AUTH_TOKEN = "correct";
    const req = makeReq("GET", "/admin/tokens", { headers: { authorization: "Bearer wrong" } });
    const res = makeRes();
    expect(checkAdminAuth(req, res)).toBe(false);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("returns true for the correct token", () => {
    process.env.AUTH_TOKEN = "correct";
    const req = makeReq("GET", "/admin/tokens", { headers: { authorization: "Bearer correct" } });
    const res = makeRes();
    expect(checkAdminAuth(req, res)).toBe(true);
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});

// ── checkAuth ─────────────────────────────────────────────────────────────────
describe("checkAuth", () => {
  beforeEach(() => {
    delete process.env.AUTH_TOKEN;
    vi.clearAllMocks();
    // Default: file not found → empty store
    mockReadFile.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockWriteFile.mockImplementation(() => {});
  });

  afterEach(() => { delete process.env.AUTH_TOKEN; });

  it("returns { ok: true, name: 'anonymous', connection: null } when AUTH_TOKEN is not set", async () => {
    const req = makeReq("POST", "/mcp");
    const res = makeRes();
    expect(await checkAuth(req, res)).toEqual({ ok: true, name: "anonymous", connection: null });
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("returns { ok: false } with 401 when no token is in the request", async () => {
    process.env.AUTH_TOKEN = "secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "" } });
    const res = makeRes();
    expect(await checkAuth(req, res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("returns { ok: true, name: 'admin', connection: null } for the correct ENV token", async () => {
    process.env.AUTH_TOKEN = "secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "Bearer secret" } });
    const res = makeRes();
    expect(await checkAuth(req, res)).toEqual({ ok: true, name: "admin", connection: null });
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("returns { ok: true, name, connection: null } for a valid file token without connection", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    const plaintext = "db-token";
    const store = {
      tokens: [{ id: 7, name: "claude-desktop", token_hash: hashToken(plaintext), active: true,
                  last_used_at: null, connection: null }],
      next_id: 8,
    };
    mockReadFile.mockReturnValueOnce(JSON.stringify(store));
    const req = makeReq("POST", "/mcp", { headers: { authorization: `Bearer ${plaintext}` } });
    const res = makeRes();
    expect(await checkAuth(req, res)).toEqual({ ok: true, name: "claude-desktop", connection: null });
    expect(mockWriteFile).toHaveBeenCalled(); // last_used_at updated
  });

  it("returns { ok: true, name, connection } for a token with a custom connection", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    const plaintext = "tok";
    const connection = { host: "myhost", port: 5433, database: "mydb", user: "u", password: "p" };
    const store = {
      tokens: [{ id: 1, name: "mytoken", token_hash: hashToken(plaintext), active: true,
                  last_used_at: null, connection }],
      next_id: 2,
    };
    mockReadFile.mockReturnValueOnce(JSON.stringify(store));
    const req = makeReq("POST", "/mcp", { headers: { authorization: `Bearer ${plaintext}` } });
    const res = makeRes();
    expect(await checkAuth(req, res)).toEqual({ ok: true, name: "mytoken", connection });
  });

  it("returns { ok: false } for a token not found in the file store", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    mockReadFile.mockReturnValueOnce(JSON.stringify({ tokens: [], next_id: 1 }));
    const req = makeReq("POST", "/mcp", { headers: { authorization: "Bearer bad" } });
    const res = makeRes();
    expect(await checkAuth(req, res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("returns { ok: false } for an inactive token", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    const plaintext = "tok";
    const store = {
      tokens: [{ id: 1, name: "disabled", token_hash: hashToken(plaintext), active: false,
                  last_used_at: null, connection: null }],
      next_id: 2,
    };
    mockReadFile.mockReturnValueOnce(JSON.stringify(store));
    const req = makeReq("POST", "/mcp", { headers: { authorization: `Bearer ${plaintext}` } });
    const res = makeRes();
    expect(await checkAuth(req, res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });
});
