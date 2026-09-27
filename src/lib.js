/**
 * Pure helpers and auth logic — no MCP SDK imports, pool is always injected.
 * Imported by index.js (production) and tests.
 */
import fs from "node:fs";
import crypto from "node:crypto";

// ── Logging ───────────────────────────────────────────────────────────────────
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Active log level from LOG_LEVEL env var (debug|info|warn|error), default info. */
export function getLogLevel() {
  const lvl = (process.env.LOG_LEVEL || "info").toLowerCase();
  return LOG_LEVELS[lvl] ? lvl : "info";
}

export function isLogEnabled(level) {
  return LOG_LEVELS[level] >= LOG_LEVELS[getLogLevel()];
}

/** Writes `[ISO timestamp] [LEVEL] [CATEGORY] message` to stderr if level is enabled. */
export function log(level, category, message) {
  if (!isLogEnabled(level)) return;
  console.error(`[${new Date().toISOString()}] [${level.toUpperCase()}] [${category}] ${message}`);
}

/** Client IP: x-real-ip → first x-forwarded-for entry → socket address. */
export function getClientIp(req) {
  return req.headers?.["x-real-ip"]
    || req.headers?.["x-forwarded-for"]?.split(",")[0].trim()
    || req.socket?.remoteAddress || "-";
}

function logAuthFailure(req, reason, tokenName) {
  const pathname = new URL(req.url || "/", "http://x").pathname;
  const tokenPart = tokenName ? ` token="${tokenName}"` : "";
  log("warn", "AUTH", `result="denied"${tokenPart} action="${req.method} ${pathname}" ip="${getClientIp(req)}" reason="${reason}"`);
}

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

let tokenStoreCache = null;
export function clearTokenStoreCache() { tokenStoreCache = null; }

// ── Store encryption (AES-256-GCM, keyed by STORE_ENCRYPTION_KEY env var) ─────
const ENC_PREFIX = "enc:v1:";

function getEncryptionKey() {
  const raw = process.env.STORE_ENCRYPTION_KEY;
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest(); // 32-byte AES-256 key
}

function encryptValue(plaintext) {
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext;
  const key = getEncryptionKey();
  if (!key) return plaintext;
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + iv.toString("hex") + ":" + tag.toString("hex") + ":" + ct.toString("hex");
}

function decryptValue(value) {
  if (typeof value !== "string" || !value.startsWith(ENC_PREFIX)) return value;
  const key = getEncryptionKey();
  if (!key) {
    log("warn", "STORE", "Encrypted password found but STORE_ENCRYPTION_KEY is not set — connection will fail.");
    return value;
  }
  const parts = value.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted value in token store — check STORE_ENCRYPTION_KEY");
  try {
    const [ivHex, tagHex, ctHex] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(ctHex, "hex"), undefined, "utf8") + decipher.final("utf8");
  } catch (err) {
    throw new Error(`Failed to decrypt store value: ${err.message} — check STORE_ENCRYPTION_KEY`, { cause: err });
  }
}

export function loadTokenStore() {
  if (tokenStoreCache) return tokenStoreCache;
  const file = getTokensFile();
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const token of data.tokens) {
      if (token.connection?.password) {
        token.connection = { ...token.connection, password: decryptValue(token.connection.password) };
      }
    }
    tokenStoreCache = data;
    return data;
  } catch (e) {
    if (e.code === "ENOENT") return { tokens: [], next_id: 1 };
    throw e;
  }
}

export function saveTokenStore(data) {
  const file  = getTokensFile();
  const key   = getEncryptionKey();
  const toWrite = key ? {
    ...data,
    tokens: data.tokens.map(t =>
      t.connection?.password
        ? { ...t, connection: { ...t.connection, password: encryptValue(t.connection.password) } }
        : t
    ),
  } : data;
  fs.writeFileSync(file, JSON.stringify(toWrite, null, 2), "utf8");
  tokenStoreCache = data;
}

/** On startup: find any tokens whose stored password is still plaintext and encrypt them. */
export function migrateTokenStore() {
  if (!getEncryptionKey()) return;
  const file = getTokensFile();
  let rawData;
  try {
    rawData = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  const plainCount = rawData.tokens.filter(
    t => t.connection?.password && !t.connection.password.startsWith(ENC_PREFIX)
  ).length;
  if (plainCount === 0) return;
  // Decrypt any values that are already encrypted, leaving plain ones as-is
  for (const token of rawData.tokens) {
    if (token.connection?.password) {
      token.connection = { ...token.connection, password: decryptValue(token.connection.password) };
    }
  }
  saveTokenStore(rawData); // re-encrypts every password
  log("info", "STORE", `Encrypted ${plainCount} plaintext password(s) in token store.`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
export function extractBearer(req) {
  const h = (req.headers && req.headers["authorization"]) || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export function send401(res) {
  const realm = process.env.MCP_SERVER_NAME || "pg-mcp-server";
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer realm="${realm}"`,
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 1_048_576) { reject(new Error("Request body too large")); return; }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function timingSafeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Admin-only auth — only the AUTH_TOKEN env var is accepted.
 *  When AUTH_TOKEN is not set, auth is disabled and all requests are allowed. */
export function checkAdminAuth(req, res) {
  const authToken = getAuthToken();
  if (!authToken) return true;
  const token = extractBearer(req);
  if (!token) { logAuthFailure(req, "missing token"); send401(res); return false; }
  if (!timingSafeEqual(token, authToken)) { logAuthFailure(req, "invalid admin token"); send401(res); return false; }
  return true;
}

/** MCP auth — accepts AUTH_TOKEN env var OR any active file token.
 *  Returns { ok: true, name: string, connection: object|null } on success,
 *  { ok: false } on failure. */
export async function checkAuth(req, res) {
  const authToken = getAuthToken();
  if (!authToken) return { ok: true, name: "anonymous", connection: null, clientConnection: envClientConnectionMode() };
  const token = extractBearer(req);
  if (!token) { logAuthFailure(req, "missing token"); send401(res); return { ok: false }; }
  if (timingSafeEqual(token, authToken)) {
    return { ok: true, name: "admin", connection: null, clientConnection: envClientConnectionMode() };
  }
  // File token check
  const hash = hashToken(token);
  const store = loadTokenStore();
  const entry = store.tokens.find(t => t.token_hash === hash);
  if (!entry) { logAuthFailure(req, "unknown token"); send401(res); return { ok: false }; }
  if (!entry.active) { logAuthFailure(req, "token disabled", entry.name); send401(res); return { ok: false }; }
  entry.last_used_at = new Date().toISOString();
  try { saveTokenStore(store); } catch { /* best-effort */ }
  return {
    ok: true, name: entry.name, connection: entry.connection || null,
    clientConnection: parseClientConnectionMode(entry.client_connection) ?? "none",
  };
}

// ── Client-supplied connection (X-Pg-* headers) ──────────────────────────────
/** What an MCP client may set itself (token field `client_connection`, PG_CLIENT_CONNECTION):
 *  none – nothing; credentials – user/password; full – also host, port, database and ssl. */
export const CLIENT_CONNECTION_MODES = ["none", "credentials", "full"];
export const CLIENT_CREDENTIAL_FIELDS = ["user", "password"];
export const CLIENT_TARGET_FIELDS = ["host", "port", "database", "ssl"];
export const CLIENT_HEADER_PREFIX = "x-pg-";

export class ClientConnectionError extends Error {
  /** @param {string} message @param {400|403} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Parses a client_connection value; undefined/null/"" → "none", invalid → null. */
export function parseClientConnectionMode(v) {
  if (v === undefined || v === null || v === "") return "none";
  const m = String(v).trim().toLowerCase();
  return CLIENT_CONNECTION_MODES.includes(m) ? m : null;
}

/** client_connection for the AUTH_TOKEN / anonymous sessions (PG_CLIENT_CONNECTION, default none). */
export function envClientConnectionMode() {
  return parseClientConnectionMode(process.env.PG_CLIENT_CONNECTION) ?? "none";
}

/** Header name for a connection field: database → X-Pg-Database. */
export function clientHeaderName(field) {
  return "X-Pg-" + field.split("_").map(w => w[0].toUpperCase() + w.slice(1)).join("-");
}

/**
 * Reads the connection parameters an MCP client sends as X-Pg-* headers (X-Pg-User, X-Pg-Password,
 * X-Pg-Host, X-Pg-Port, X-Pg-Database, X-Pg-Ssl). Returns null without such headers; throws
 * ClientConnectionError (400) on unknown headers or invalid values.
 */
export function clientConnectionFromHeaders(headers) {
  const known = [...CLIENT_CREDENTIAL_FIELDS, ...CLIENT_TARGET_FIELDS];
  const conn = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith(CLIENT_HEADER_PREFIX) || value === undefined) continue;
    const field = name.slice(CLIENT_HEADER_PREFIX.length).replaceAll("-", "_");
    const v = String(Array.isArray(value) ? value[0] : value).trim();
    if (!v) continue;
    if (!known.includes(field)) {
      throw new ClientConnectionError(`Unknown header ${clientHeaderName(field)} (allowed: ${known.map(clientHeaderName).join(", ")})`, 400);
    }
    conn[field] = v;
  }
  if (!Object.keys(conn).length) return null;
  if (conn.port !== undefined && !/^\d+$/.test(conn.port)) throw new ClientConnectionError('"port" must be a number', 400);
  if (conn.ssl !== undefined) {
    const ssl = conn.ssl.toLowerCase();
    if (!["true", "false"].includes(ssl)) throw new ClientConnectionError('"ssl" must be true or false', 400);
    conn.ssl = ssl;
  }
  return conn;
}

/**
 * Applies connection parameters sent by an MCP client on top of the token's connection
 * (null = server default). Throws ClientConnectionError (403 not permitted, 400 invalid).
 * Rules: credentials come as user + password pair; any target field (host, port, database,
 * ssl) requires client credentials, so the token's or server's password is never sent to a
 * host chosen by the client (getPool fills missing fields from PG_* individually). Without a
 * token connection the server's TLS settings (PG_SSL) are kept via ssl "default".
 */
export function applyClientConnection(token, client, mode) {
  const keys = Object.keys(client ?? {}).filter(k => client[k] !== undefined && client[k] !== null && String(client[k]).trim() !== "");
  if (!keys.length) return token;
  if (mode === "none") {
    throw new ClientConnectionError("This token does not allow client-supplied connection parameters", 403);
  }
  const allowed = mode === "full" ? [...CLIENT_CREDENTIAL_FIELDS, ...CLIENT_TARGET_FIELDS] : CLIENT_CREDENTIAL_FIELDS;
  const denied = keys.filter(k => !allowed.includes(k));
  if (denied.length) {
    throw new ClientConnectionError(`Not allowed for this token (client_connection=${mode}): ${denied.join(", ")}`, 403);
  }
  const hasUser = keys.includes("user");
  if (hasUser !== keys.includes("password")) throw new ClientConnectionError("user and password must be supplied together", 400);
  const hasTarget = keys.some(k => CLIENT_TARGET_FIELDS.includes(k));
  if (hasTarget && !hasUser) {
    throw new ClientConnectionError("Client-supplied host, port, database or ssl requires user and password", 400);
  }
  const out = token ? { ...token } : { ssl: "default" };
  if (keys.includes("host")) { delete out.port; delete out.database; }
  for (const k of keys) out[k] = client[k];
  return out;
}

// ── Admin: token management (/admin/tokens[/:id]) ────────────────────────────
const CLIENT_MODE_ERROR = '"client_connection" must be none, credentials or full';

export async function handleAdminRequest(req, res, { onDelete } = {}) {
  if (!checkAdminAuth(req, res)) return;

  const pathname = new URL(req.url, "http://x").pathname;
  const match = pathname.match(/^\/admin\/tokens(?:\/(\d+))?$/);
  if (!match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  const id = match[1] ? parseInt(match[1], 10) : null;

  const ip = getClientIp(req);
  // Auth disabled → requests are unauthenticated, don't attribute them to the admin token
  const tokenName = getAuthToken() ? "admin" : "anonymous";
  log("info", "ADMIN", `token="${tokenName}" action="${req.method} ${pathname}" ip="${ip}"`);

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
      const { name, connection, client_connection } = JSON.parse(body || "{}");
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
      const clientMode = parseClientConnectionMode(client_connection);
      if (!clientMode) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: CLIENT_MODE_ERROR }));
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
        ...(clientMode !== "none" && { client_connection: clientMode }),
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
      if (updates.name === undefined && updates.active === undefined && updates.connection === undefined
          && updates.client_connection === undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No valid fields (name, active, connection, client_connection)" }));
        return;
      }
      if (updates.name !== undefined && (typeof updates.name !== "string" || !updates.name.trim())) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '"name" must be a non-empty string' }));
        return;
      }
      if (updates.connection !== undefined && updates.connection !== null
          && (typeof updates.connection !== "object" || Array.isArray(updates.connection))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: '"connection" must be an object or null' }));
        return;
      }
      const clientMode = parseClientConnectionMode(updates.client_connection);
      if (!clientMode) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: CLIENT_MODE_ERROR }));
        return;
      }
      const store = loadTokenStore();
      const entry = store.tokens.find(t => t.id === id);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      if (updates.name     !== undefined) entry.name       = updates.name.trim();
      if (updates.active   !== undefined) entry.active     = !!updates.active;
      if (updates.connection !== undefined) entry.connection = updates.connection || null;
      if (updates.client_connection !== undefined) {
        if (clientMode === "none") delete entry.client_connection;
        else entry.client_connection = clientMode;
      }
      saveTokenStore(store);
      const { token_hash: _h2, ...safe } = entry;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(safe));
      return;
    }

    // DELETE /admin/tokens/:id – permanently remove token
    if (req.method === "DELETE" && id) {
      const store = loadTokenStore();
      const idx = store.tokens.findIndex(t => t.id === id);
      if (idx === -1) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      const [deleted] = store.tokens.splice(idx, 1);
      saveTokenStore(store);
      onDelete?.(deleted);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id }));
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
  } catch (err) {
    log("error", "ADMIN", `token="${tokenName}" action="${req.method} ${pathname}" ip="${ip}" error=${JSON.stringify(err.message)}`);
    if (err.stack) log("debug", "ADMIN", err.stack);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}
