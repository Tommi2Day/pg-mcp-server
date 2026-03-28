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

  it("returns false with 503 when AUTH_TOKEN is not configured", () => {
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    expect(checkAdminAuth(req, res)).toBe(false);
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(resBody(res)).toMatchObject({ error: expect.stringContaining("AUTH_TOKEN") });
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
  let mockPool;

  beforeEach(() => {
    delete process.env.AUTH_TOKEN;
    mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  });

  afterEach(() => { delete process.env.AUTH_TOKEN; });

  it("returns { ok: true, name: 'anonymous' } when AUTH_TOKEN is not set (auth disabled)", async () => {
    const req = makeReq("POST", "/mcp");
    const res = makeRes();
    expect(await checkAuth(mockPool, req, res)).toEqual({ ok: true, name: "anonymous" });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("returns { ok: false } with 401 when no token is in the request", async () => {
    process.env.AUTH_TOKEN = "secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "" } });
    const res = makeRes();
    expect(await checkAuth(mockPool, req, res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("returns { ok: true, name: 'admin' } for the correct ENV token", async () => {
    process.env.AUTH_TOKEN = "secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "Bearer secret" } });
    const res = makeRes();
    expect(await checkAuth(mockPool, req, res)).toEqual({ ok: true, name: "admin" });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("returns { ok: true, name: <token-name> } for a valid DB token", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "Bearer db-token" } });
    const res = makeRes();
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 7, name: "claude-desktop" }] })  // SELECT
      .mockResolvedValueOnce({ rows: [] });                                    // UPDATE last_used_at
    expect(await checkAuth(mockPool, req, res)).toEqual({ ok: true, name: "claude-desktop" });
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, name FROM mcp_auth_tokens"),
      [hashToken("db-token")]
    );
  });

  it("returns { ok: false } for a token not found in DB", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "Bearer bad" } });
    const res = makeRes();
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    expect(await checkAuth(mockPool, req, res)).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });
});
