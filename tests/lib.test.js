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
  it("gibt einen 64-stelligen Hex-String zurück", () => {
    expect(hashToken("hello")).toHaveLength(64);
    expect(hashToken("hello")).toMatch(/^[0-9a-f]+$/);
  });

  it("ist deterministisch", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("produziert verschiedene Hashes für verschiedene Eingaben", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("stimmt mit node:crypto SHA-256 überein", () => {
    const expected = crypto.createHash("sha256").update("test-token").digest("hex");
    expect(hashToken("test-token")).toBe(expected);
  });
});

// ── extractBearer ─────────────────────────────────────────────────────────────
describe("extractBearer", () => {
  it("extrahiert den Token aus einem gültigen Bearer-Header", () => {
    expect(extractBearer({ headers: { authorization: "Bearer mytoken123" } })).toBe("mytoken123");
  });

  it("gibt leeren String zurück wenn kein Authorization-Header vorhanden", () => {
    expect(extractBearer({ headers: {} })).toBe("");
  });

  it("gibt leeren String zurück für nicht-Bearer Schemes", () => {
    expect(extractBearer({ headers: { authorization: "Basic dXNlcjpwYXNz" } })).toBe("");
  });

  it("gibt leeren String zurück für 'Bearer ' ohne Token", () => {
    expect(extractBearer({ headers: { authorization: "Bearer " } })).toBe("");
  });

  it("gibt leeren String zurück wenn headers undefined ist", () => {
    expect(extractBearer({})).toBe("");
  });
});

// ── send401 ───────────────────────────────────────────────────────────────────
describe("send401", () => {
  it("setzt Status 401 mit WWW-Authenticate Header", () => {
    const res = makeRes();
    send401(res);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.objectContaining({
      "WWW-Authenticate": 'Bearer realm="pg-mcp-server"',
      "Content-Type": "application/json",
    }));
  });

  it("schreibt JSON-Fehlerantwort", () => {
    const res = makeRes();
    send401(res);
    expect(resBody(res)).toEqual({ error: "Unauthorized" });
  });
});

// ── readBody ──────────────────────────────────────────────────────────────────
describe("readBody", () => {
  it("löst mit verketteten Chunks auf", async () => {
    const req = new EventEmitter();
    const promise = readBody(req);
    req.emit("data", "hel");
    req.emit("data", "lo");
    req.emit("end");
    expect(await promise).toBe("hello");
  });

  it("löst mit leerem String auf wenn kein Body", async () => {
    const req = new EventEmitter();
    const promise = readBody(req);
    req.emit("end");
    expect(await promise).toBe("");
  });

  it("lehnt bei Stream-Fehler ab", async () => {
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

  it("gibt false zurück wenn PG_SSL nicht gesetzt", () => {
    expect(buildPgSsl()).toBe(false);
  });

  it("gibt false zurück für PG_SSL=false", () => {
    process.env.PG_SSL = "false";
    expect(buildPgSsl()).toBe(false);
  });

  it("gibt false zurück für PG_SSL=0", () => {
    process.env.PG_SSL = "0";
    expect(buildPgSsl()).toBe(false);
  });

  it("gibt SSL-Config mit rejectUnauthorized=false zurück für PG_SSL=true", () => {
    process.env.PG_SSL = "true";
    expect(buildPgSsl()).toMatchObject({ rejectUnauthorized: false });
  });

  it("ruft process.exit auf für PG_SSL=verify ohne PG_SSL_CA_FILE", () => {
    process.env.PG_SSL = "verify";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    expect(() => buildPgSsl()).toThrow("exit");
    exitSpy.mockRestore();
  });
});

// ── getAuthToken ──────────────────────────────────────────────────────────────
describe("getAuthToken", () => {
  afterEach(() => { delete process.env.AUTH_TOKEN; });

  it("gibt leeren String zurück wenn AUTH_TOKEN nicht gesetzt", () => {
    expect(getAuthToken()).toBe("");
  });

  it("gibt den gesetzten AUTH_TOKEN zurück", () => {
    process.env.AUTH_TOKEN = "my-secret";
    expect(getAuthToken()).toBe("my-secret");
  });
});

// ── checkAdminAuth ────────────────────────────────────────────────────────────
describe("checkAdminAuth", () => {
  afterEach(() => { delete process.env.AUTH_TOKEN; });

  it("gibt false zurück mit 503 wenn AUTH_TOKEN nicht konfiguriert", () => {
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    expect(checkAdminAuth(req, res)).toBe(false);
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(resBody(res)).toMatchObject({ error: expect.stringContaining("AUTH_TOKEN") });
  });

  it("gibt false zurück mit 401 bei falschem Token", () => {
    process.env.AUTH_TOKEN = "correct";
    const req = makeReq("GET", "/admin/tokens", { headers: { authorization: "Bearer wrong" } });
    const res = makeRes();
    expect(checkAdminAuth(req, res)).toBe(false);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("gibt true zurück bei korrektem Token", () => {
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

  it("gibt true zurück wenn AUTH_TOKEN nicht gesetzt (Auth deaktiviert)", async () => {
    const req = makeReq("POST", "/mcp");
    const res = makeRes();
    expect(await checkAuth(mockPool, req, res)).toBe(true);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("gibt false zurück mit 401 wenn kein Token im Request", async () => {
    process.env.AUTH_TOKEN = "secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "" } });
    const res = makeRes();
    expect(await checkAuth(mockPool, req, res)).toBe(false);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("gibt true zurück bei korrektem ENV-Token", async () => {
    process.env.AUTH_TOKEN = "secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "Bearer secret" } });
    const res = makeRes();
    expect(await checkAuth(mockPool, req, res)).toBe(true);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("gibt true zurück bei gültigem DB-Token", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "Bearer db-token" } });
    const res = makeRes();
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })  // SELECT
      .mockResolvedValueOnce({ rows: [] });            // UPDATE last_used_at
    expect(await checkAuth(mockPool, req, res)).toBe(true);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id FROM mcp_auth_tokens"),
      [hashToken("db-token")]
    );
  });

  it("gibt false zurück bei ungültigem Token nicht in DB", async () => {
    process.env.AUTH_TOKEN = "admin-secret";
    const req = makeReq("POST", "/mcp", { headers: { authorization: "Bearer bad" } });
    const res = makeRes();
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    expect(await checkAuth(mockPool, req, res)).toBe(false);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });
});
