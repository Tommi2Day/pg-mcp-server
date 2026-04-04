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

// ── Token store (file-based) ──────────────────────────────────────────────────
export function getTokensFile() {
  return process.env.TOKENS_FILE || "./tokens.json";
}

export function loadTokenStore() {
  const file = getTokensFile();
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { tokens: [], next_id: 1 };
    throw e;
  }
}

export function saveTokenStore(data) {
  const file = getTokensFile();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
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

/** Admin-only auth — only the AUTH_TOKEN env var is accepted.
 *  When AUTH_TOKEN is not set, auth is disabled and all requests are allowed. */
export function checkAdminAuth(req, res) {
  const authToken = getAuthToken();
  if (!authToken) return true;
  if (extractBearer(req) !== authToken) { send401(res); return false; }
  return true;
}

/** MCP auth — accepts AUTH_TOKEN env var OR any active file token.
 *  Returns { ok: true, name: string, connection: object|null } on success,
 *  { ok: false } on failure. */
export async function checkAuth(req, res) {
  const authToken = getAuthToken();
  if (!authToken) return { ok: true, name: "anonymous", connection: null };
  const token = extractBearer(req);
  if (!token) { send401(res); return { ok: false }; }
  if (token === authToken) return { ok: true, name: "admin", connection: null };
  // File token check
  const hash = hashToken(token);
  const store = loadTokenStore();
  const entry = store.tokens.find(t => t.token_hash === hash && t.active);
  if (!entry) { send401(res); return { ok: false }; }
  entry.last_used_at = new Date().toISOString();
  try { saveTokenStore(store); } catch { /* best-effort */ }
  return { ok: true, name: entry.name, connection: entry.connection || null };
}

// ── Admin: token management (/admin/tokens[/:id]) ────────────────────────────
export async function handleAdminRequest(req, res) {
  if (!checkAdminAuth(req, res)) return;

  const pathname = new URL(req.url, "http://x").pathname;
  const idStr = pathname.replace(/^\/admin\/tokens\/?/, "");
  const id    = idStr ? parseInt(idStr, 10) : null;

  const ip = req.headers["x-real-ip"]
    || req.headers["x-forwarded-for"]?.split(",")[0].trim()
    || req.socket?.remoteAddress || "-";
  console.error(`[${new Date().toISOString()}] [ADMIN] token="admin" action="${req.method} ${pathname}" ip="${ip}"`);

  try {
    // GET /admin/tokens – list all tokens (token_hash excluded)
    if (req.method === "GET" && !id) {
      const { tokens } = loadTokenStore();
      const safe = tokens.map(({ token_hash: _h, ...rest }) => rest);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tokens: safe }));
      return;
    }

    // POST /admin/tokens – create new token
    if (req.method === "POST" && !id) {
      const body = await readBody(req);
      const { name, connection } = JSON.parse(body || "{}");
      if (!name || typeof name !== "string" || !name.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '"name" is required' }));
        return;
      }
      if (connection !== undefined && (typeof connection !== "object" || Array.isArray(connection))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '"connection" must be an object or null' }));
        return;
      }
      const token = crypto.randomBytes(32).toString("hex");
      const store = loadTokenStore();
      const entry = {
        id:           store.next_id++,
        name:         name.trim(),
        token_hash:   hashToken(token),
        created_at:   new Date().toISOString(),
        last_used_at: null,
        active:       true,
        connection:   connection || null,
      };
      store.tokens.push(entry);
      saveTokenStore(store);
      const { token_hash: _h, ...safe } = entry;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...safe, token })); // plaintext returned once only
      return;
    }

    // PATCH /admin/tokens/:id – update name, active and/or connection
    if (req.method === "PATCH" && id) {
      const body = await readBody(req);
      const updates = JSON.parse(body || "{}");
      if (updates.name === undefined && updates.active === undefined && updates.connection === undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No valid fields (name, active, connection)" }));
        return;
      }
      if (updates.connection !== undefined && updates.connection !== null
          && (typeof updates.connection !== "object" || Array.isArray(updates.connection))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '"connection" must be an object or null' }));
        return;
      }
      const store = loadTokenStore();
      const entry = store.tokens.find(t => t.id === id);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      if (updates.name     !== undefined) entry.name       = updates.name;
      if (updates.active   !== undefined) entry.active     = !!updates.active;
      if (updates.connection !== undefined) entry.connection = updates.connection || null;
      saveTokenStore(store);
      const { token_hash: _h2, ...safe } = entry;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(safe));
      return;
    }

    // DELETE /admin/tokens/:id – deactivate token
    if (req.method === "DELETE" && id) {
      const store = loadTokenStore();
      const entry = store.tokens.find(t => t.id === id);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      entry.active = false;
      saveTokenStore(store);
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
