/**
 * Pure helpers and auth logic — no MCP SDK imports, pool is always injected.
 * Imported by index.js (production) and tests.
 */
import fs from "node:fs";
import crypto from "node:crypto";

// ── File / env helpers ────────────────────────────────────────────────────────
export function readFileEnv(envVar) {
  const path = process.env[envVar];
  if (!path) return undefined;
  try {
    return fs.readFileSync(path);
  } catch (e) {
    console.error(`❌ Cannot read ${envVar}="${path}": ${e.message}`);
    process.exit(1);
  }
}

export function buildPgSsl() {
  const mode = (process.env.PG_SSL || "false").toLowerCase();
  if (mode === "false" || mode === "0" || mode === "no" || mode === "prefer") return false;

  const sslConfig = {};
  if (mode === "verify") {
    sslConfig.rejectUnauthorized = true;
    const ca = readFileEnv("PG_SSL_CA_FILE");
    if (!ca) {
      console.error("❌ PG_SSL=verify requires PG_SSL_CA_FILE to be set.");
      process.exit(1);
    }
    sslConfig.ca = ca;
  } else {
    sslConfig.rejectUnauthorized = false;
  }
  const cert = readFileEnv("PG_SSL_CERT_FILE");
  const key  = readFileEnv("PG_SSL_KEY_FILE");
  if (cert) sslConfig.cert = cert;
  if (key)  sslConfig.key  = key;
  return sslConfig;
}

// ── Token helpers ─────────────────────────────────────────────────────────────
export function getAuthToken() {
  return process.env.AUTH_TOKEN || "";
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
export function extractBearer(req) {
  const h = (req.headers && req.headers["authorization"]) || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export function send401(res) {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="pg-mcp-server"',
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/** Admin-only auth — only the AUTH_TOKEN env var is accepted. */
export function checkAdminAuth(req, res) {
  const authToken = getAuthToken();
  if (!authToken) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "AUTH_TOKEN not configured – admin API disabled" }));
    return false;
  }
  if (extractBearer(req) !== authToken) { send401(res); return false; }
  return true;
}

/** MCP auth — accepts AUTH_TOKEN env var OR any active DB token.
 *  Returns { ok: true, name: string } on success, { ok: false } on failure. */
export async function checkAuth(pool, req, res) {
  const authToken = getAuthToken();
  if (!authToken) return { ok: true, name: "anonymous" }; // auth disabled
  const token = extractBearer(req);
  if (!token) { send401(res); return { ok: false }; }
  if (token === authToken) return { ok: true, name: "admin" };
  // DB token check
  const hash = hashToken(token);
  const { rows } = await pool.query(
    "SELECT id, name FROM mcp_auth_tokens WHERE token_hash = $1 AND active = true",
    [hash]
  );
  if (!rows.length) { send401(res); return { ok: false }; }
  pool.query("UPDATE mcp_auth_tokens SET last_used_at = now() WHERE id = $1", [rows[0].id]).catch(() => {});
  return { ok: true, name: rows[0].name };
}

// ── Admin: token management (/admin/tokens[/:id]) ────────────────────────────
export async function handleAdminRequest(pool, req, res) {
  if (!checkAdminAuth(req, res)) return;

  const pathname = new URL(req.url, "http://x").pathname;
  const idStr = pathname.replace(/^\/admin\/tokens\/?/, "");
  const id    = idStr ? parseInt(idStr, 10) : null;

  const ip = req.headers["x-real-ip"]
    || req.headers["x-forwarded-for"]?.split(",")[0].trim()
    || req.socket?.remoteAddress || "-";
  console.error(`[${new Date().toISOString()}] [ADMIN] token="admin" action="${req.method} ${pathname}" ip="${ip}"`);

  try {
    // GET /admin/tokens – list all tokens
    if (req.method === "GET" && !id) {
      const { rows } = await pool.query(
        "SELECT id, name, created_at, last_used_at, active FROM mcp_auth_tokens ORDER BY created_at DESC"
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tokens: rows }));
      return;
    }

    // POST /admin/tokens – create new token
    if (req.method === "POST" && !id) {
      const body = await readBody(req);
      const { name } = JSON.parse(body || "{}");
      if (!name || typeof name !== "string" || !name.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '"name" is required' }));
        return;
      }
      const token = crypto.randomBytes(32).toString("hex");
      const { rows } = await pool.query(
        "INSERT INTO mcp_auth_tokens (name, token_hash) VALUES ($1, $2) RETURNING id, name, created_at",
        [name.trim(), hashToken(token)]
      );
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...rows[0], token })); // plaintext returned once only
      return;
    }

    // PATCH /admin/tokens/:id – update name or active
    if (req.method === "PATCH" && id) {
      const body = await readBody(req);
      const updates = JSON.parse(body || "{}");
      const fields = [], values = [];
      if (updates.name   !== undefined) fields.push(`name = $${values.push(updates.name)}`);
      if (updates.active !== undefined) fields.push(`active = $${values.push(!!updates.active)}`);
      if (!fields.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No valid fields (name, active)" }));
        return;
      }
      values.push(id);
      const { rows } = await pool.query(
        `UPDATE mcp_auth_tokens SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING id, name, active`,
        values
      );
      if (!rows.length) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rows[0]));
      return;
    }

    // DELETE /admin/tokens/:id – deactivate token
    if (req.method === "DELETE" && id) {
      const { rows } = await pool.query(
        "UPDATE mcp_auth_tokens SET active = false WHERE id = $1 RETURNING id",
        [id]
      );
      if (!rows.length) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id }));
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}
