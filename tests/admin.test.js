import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleAdminRequest } from "../lib.js";
import { makeReq, makeRes, resBody } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token";

describe("handleAdminRequest", () => {
  let mockPool;

  beforeEach(() => {
    process.env.AUTH_TOKEN = ADMIN_TOKEN;
    mockPool = { query: vi.fn() };
  });

  afterEach(() => { delete process.env.AUTH_TOKEN; });

  // ── Auth guard ──────────────────────────────────────────────────────────────
  it("gibt 503 zurück wenn AUTH_TOKEN nicht konfiguriert", async () => {
    delete process.env.AUTH_TOKEN;
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("gibt 401 zurück bei falschem Admin-Token", async () => {
    const req = makeReq("GET", "/admin/tokens", { headers: { authorization: "Bearer wrong" } });
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  // ── GET /admin/tokens ───────────────────────────────────────────────────────
  it("GET listet alle Token auf", async () => {
    const tokens = [
      { id: 1, name: "claude", active: true, created_at: "2025-01-01", last_used_at: null },
    ];
    mockPool.query.mockResolvedValueOnce({ rows: tokens });
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(resBody(res)).toEqual({ tokens });
  });

  // ── POST /admin/tokens ──────────────────────────────────────────────────────
  it("POST erstellt ein neues Token", async () => {
    const created = { id: 2, name: "new-client", created_at: "2025-01-01" };
    mockPool.query.mockResolvedValueOnce({ rows: [created] });
    const req = makeReq("POST", "/admin/tokens", { body: JSON.stringify({ name: "new-client" }) });
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
    const body = resBody(res);
    expect(body.name).toBe("new-client");
    expect(body.id).toBe(2);
    // Token-Klartext muss enthalten sein und 64 hex chars haben
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    // DB speichert nur den Hash, nicht den Klartext
    const [, params] = mockPool.query.mock.calls[0];
    expect(params[1]).not.toBe(body.token);
    expect(params[1]).toHaveLength(64); // SHA-256 hex
  });

  it("POST gibt 400 zurück wenn name fehlt", async () => {
    const req = makeReq("POST", "/admin/tokens", { body: JSON.stringify({}) });
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("POST gibt 400 zurück wenn name nur Whitespace ist", async () => {
    const req = makeReq("POST", "/admin/tokens", { body: JSON.stringify({ name: "   " }) });
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  // ── PATCH /admin/tokens/:id ─────────────────────────────────────────────────
  it("PATCH aktualisiert name und active", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3, name: "renamed", active: false }] });
    const req = makeReq("PATCH", "/admin/tokens/3", {
      body: JSON.stringify({ name: "renamed", active: false }),
    });
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(resBody(res)).toMatchObject({ id: 3, name: "renamed", active: false });
  });

  it("PATCH gibt 400 zurück wenn keine gültigen Felder angegeben", async () => {
    const req = makeReq("PATCH", "/admin/tokens/3", { body: JSON.stringify({}) });
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("PATCH gibt 404 zurück wenn Token nicht gefunden", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const req = makeReq("PATCH", "/admin/tokens/99", { body: JSON.stringify({ name: "x" }) });
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  // ── DELETE /admin/tokens/:id ────────────────────────────────────────────────
  it("DELETE deaktiviert ein Token", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    const req = makeReq("DELETE", "/admin/tokens/5");
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(resBody(res)).toEqual({ ok: true, id: 5 });
    // Prüfe dass active=false gesetzt wird
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain("active = false");
    expect(params).toContain(5);
  });

  it("DELETE gibt 404 zurück wenn Token nicht gefunden", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const req = makeReq("DELETE", "/admin/tokens/99");
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  // ── Fehlerbehandlung ────────────────────────────────────────────────────────
  it("gibt 405 zurück für nicht erlaubte Methode", async () => {
    const req = makeReq("PUT", "/admin/tokens");
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
  });

  it("gibt 500 zurück bei DB-Fehler", async () => {
    mockPool.query.mockRejectedValueOnce(new Error("connection lost"));
    const req = makeReq("GET", "/admin/tokens");
    const res = makeRes();
    await handleAdminRequest(mockPool, req, res);
    expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(resBody(res)).toMatchObject({ error: "connection lost" });
  });
});
