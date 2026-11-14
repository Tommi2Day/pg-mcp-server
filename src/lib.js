/**
 * Pure helpers and auth logic — no MCP SDK imports, pool is always injected.
 * Imported by index.js (production) and tests.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import {
  getOAuthConfig, verifyJwt, looksLikeJwt, identityFromClaims, resolveAccess, envAssignments,
  sessionFromRequest, safeLogValue, OAuthError, assignmentError, ASSIGNMENT_FIELDS,
} from "./oauth.js";

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

/** Audit trail line `[AUDIT] key="value" …` (who did what); values are sanitized, never contains secrets. */
export function audit(fields) {
  const parts = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}="${safeLogValue(v, 256)}"`);
  log("info", "AUDIT", parts.join(" "));
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

/** Applies fn to the stored connection password of every token and assignment. */
function mapStoredPasswords(data, fn) {
  const map = (e) => (e.connection?.password ? { ...e, connection: { ...e.connection, password: fn(e.connection.password) } } : e);
  return {
    ...data,
    tokens: data.tokens.map(map),
    ...(Array.isArray(data.assignments) && { assignments: data.assignments.map(map) }),
  };
}

export function loadTokenStore() {
  if (tokenStoreCache) return tokenStoreCache;
  const file = getTokensFile();
  try {
    const data = mapStoredPasswords(JSON.parse(fs.readFileSync(file, "utf8")), decryptValue);
    tokenStoreCache = data;
    return data;
  } catch (e) {
    if (e.code === "ENOENT") return { tokens: [], next_id: 1 };
    throw e;
  }
}

export function saveTokenStore(data) {
  const file  = getTokensFile();
  const toWrite = getEncryptionKey() ? mapStoredPasswords(data, encryptValue) : data;
  fs.writeFileSync(file, JSON.stringify(toWrite, null, 2), "utf8");
  tokenStoreCache = data;
}

/** On startup: find any tokens / assignments whose stored password is still plaintext and encrypt them. */
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
  const entries = [...rawData.tokens, ...(rawData.assignments ?? [])];
  const plainCount = entries.filter(
    t => t.connection?.password && !t.connection.password.startsWith(ENC_PREFIX)
  ).length;
  if (plainCount === 0) return;
  // Decrypt any values that are already encrypted, leaving plain ones as-is
  saveTokenStore(mapStoredPasswords(rawData, decryptValue)); // re-encrypts every password
  log("info", "STORE", `Encrypted ${plainCount} plaintext password(s) in token store.`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
export function extractBearer(req) {
  const h = (req.headers && req.headers["authorization"]) || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

export function send401(res) {
  const realm = process.env.MCP_SERVER_NAME || "pg-mcp-server";
  const publicUrl = getOAuthConfig()?.publicUrl;
  const metadata = publicUrl ? `, resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"` : "";
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer realm="${realm}"${metadata}`,
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export function send403(res, message = "Forbidden") {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
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

/** All assignments: env (read-only) first, then the ones stored via the admin UI. */
export function allAssignments() {
  return [...envAssignments(), ...(loadTokenStore().assignments ?? [])];
}

/** Validates a bearer JWT. Returns { identity } or { error } (reason safe to log). */
async function verifyBearerIdentity(token, oauth) {
  try {
    return { identity: identityFromClaims(await verifyJwt(token, oauth), oauth) };
  } catch (e) {
    return { error: e instanceof OAuthError ? e.message : "token validation failed" };
  }
}

/** Authenticated identity → access decision; a denial is logged (AUTH). */
function decideAccess(req, identity) {
  const access = resolveAccess(identity, allAssignments());
  if (!access.allowed) {
    const hint = identity.groupsOverage ? " (token has too many groups: group list not included - use app-assigned groups or roles)" : "";
    logAuthFailure(req, `oauth: no assignment for this user or groups${hint}`, identity.display);
  }
  return access;
}

/** MCP request with an OAuth access token (JWT). */
async function checkOAuthBearer(req, res, token, oauth) {
  const { identity, error } = await verifyBearerIdentity(token, oauth);
  if (!identity) { logAuthFailure(req, `oauth: ${error}`); send401(res); return { ok: false }; }
  const access = decideAccess(req, identity);
  if (!access.allowed) { send403(res, "No access: user or groups are not assigned to this server"); return { ok: false }; }
  return {
    ok: true, name: identity.display, connection: access.connection,
    clientConnection: parseClientConnectionMode(access.clientConnection) ?? "none",
    identity: { sub: identity.sub, email: identity.email, name: identity.name, assignment: access.assignment, admin: access.admin },
  };
}

/** File-token lookup for /mcp (see checkAuth). */
function checkFileToken(req, res, token) {
  const store = loadTokenStore();
  const entry = store.tokens.find(t => t.token_hash === hashToken(token));
  if (!entry) { logAuthFailure(req, "unknown token"); send401(res); return { ok: false }; }
  if (!entry.active) { logAuthFailure(req, "token disabled", entry.name); send401(res); return { ok: false }; }
  entry.last_used_at = new Date().toISOString();
  try { saveTokenStore(store); } catch { /* best-effort */ }
  return {
    ok: true, name: entry.name, connection: entry.connection || null,
    clientConnection: parseClientConnectionMode(entry.client_connection) ?? "none",
  };
}

/** MCP auth — accepts AUTH_TOKEN env var, any active file token or (OAUTH_ISSUER set) an OAuth access token.
 *  Returns { ok: true, name, connection, clientConnection[, identity] } on success, { ok: false } on failure.
 *  Without AUTH_TOKEN and OAuth, auth is disabled. */
export async function checkAuth(req, res) {
  const authToken = getAuthToken();
  const oauth = getOAuthConfig();
  if (!authToken && !oauth) return { ok: true, name: "anonymous", connection: null, clientConnection: envClientConnectionMode() };
  const token = extractBearer(req);
  if (!token) { logAuthFailure(req, "missing token"); send401(res); return { ok: false }; }
  if (authToken && timingSafeEqual(token, authToken)) {
    return { ok: true, name: "admin", connection: null, clientConnection: envClientConnectionMode() };
  }
  if (oauth && looksLikeJwt(token)) return checkOAuthBearer(req, res, token, oauth);
  return checkFileToken(req, res, token);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Identity behind an admin request: bearer JWT, else the browser session cookie. */
async function adminIdentity(req, token, oauth) {
  if (token && looksLikeJwt(token)) return { ...await verifyBearerIdentity(token, oauth), via: "bearer" };
  const session = sessionFromRequest(req);
  return session ? { identity: session.identity, via: "session" } : { error: "missing token" };
}

/**
 * Admin API / Admin UI authentication. Returns { ok, name, method } (res already answered when not ok).
 *  - AUTH_TOKEN bearer -> "admin"
 *  - OAuth (OAUTH_ISSUER): bearer JWT or login session of a user whose assignment has admin:true.
 *    Session cookies are protected against CSRF: changing requests need an X-Requested-With header.
 *  - neither configured -> "anonymous"
 */
export async function authenticateAdmin(req, res) {
  const oauth = getOAuthConfig();
  if (!oauth) {
    if (!checkAdminAuth(req, res)) return { ok: false };
    return getAuthToken() ? { ok: true, name: "admin", method: "token" } : { ok: true, name: "anonymous", method: "none" };
  }
  const token = extractBearer(req);
  const authToken = getAuthToken();
  if (token && authToken && timingSafeEqual(token, authToken)) return { ok: true, name: "admin", method: "token" };
  const { identity, via, error } = await adminIdentity(req, token, oauth);
  if (!identity) { logAuthFailure(req, `oauth: ${error}`); send401(res); return { ok: false }; }
  const access = decideAccess(req, identity);
  if (!access.admin) {
    if (access.allowed) logAuthFailure(req, "oauth: not an admin", identity.display);
    send403(res, "Admin rights required");
    return { ok: false };
  }
  if (via === "session" && !SAFE_METHODS.has(req.method) && !req.headers?.["x-requested-with"]) {
    logAuthFailure(req, "oauth: missing X-Requested-With header (CSRF protection)", identity.display);
    send403(res, "Missing X-Requested-With header");
    return { ok: false };
  }
  return { ok: true, name: identity.display, method: "oauth", identity };
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
  return validateClientValues(conn);
}

/** Checks port and ssl of a client-supplied connection; ssl is normalized to lower case. */
function validateClientValues(conn) {
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

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const isConnectionValue = (c) => c === null || (typeof c === "object" && !Array.isArray(c));

/** Secret connection fields never leave the server: the API shows `<field>_set: true` instead. */
const SECRET_FIELDS = ["password"];

/** Entry (token or assignment) with the secrets of its connection replaced by `<field>_set` flags. */
function maskConnection(entry) {
  if (!entry?.connection) return entry;
  const conn = { ...entry.connection };
  for (const f of SECRET_FIELDS) {
    if (conn[f]) { delete conn[f]; conn[`${f}_set`] = true; }
  }
  return { ...entry, connection: conn };
}

/**
 * PATCH semantics for secrets: an omitted password keeps the stored one (the API never shows it, so a client
 * editing the host cannot send it back); an explicit empty string clears it. `<field>_set` flags are ignored.
 */
function mergeSecrets(updated, existing) {
  if (!updated || typeof updated !== "object") return updated || null;
  const out = { ...updated };
  for (const f of SECRET_FIELDS) {
    delete out[`${f}_set`];
    if (out[f] === undefined && existing?.[f]) out[f] = existing[f];
  }
  return out;
}

const withoutHash = ({ token_hash: _h, ...rest }) => maskConnection(rest);

/** Validation error for POST /admin/tokens, or null. */
function createTokenError({ name, connection, client_connection }) {
  if (!name || typeof name !== "string" || !name.trim()) return '"name" is required';
  if (connection !== undefined && !isConnectionValue(connection)) return '"connection" must be an object or null';
  if (!parseClientConnectionMode(client_connection)) return CLIENT_MODE_ERROR;
  return null;
}

/** Validation error for PATCH /admin/tokens/:id, or null. */
function updateTokenError(updates) {
  if (updates.name === undefined && updates.active === undefined && updates.connection === undefined
      && updates.client_connection === undefined) {
    return "No valid fields (name, active, connection, client_connection)";
  }
  if (updates.name !== undefined && (typeof updates.name !== "string" || !updates.name.trim())) return '"name" must be a non-empty string';
  if (updates.connection !== undefined && !isConnectionValue(updates.connection)) return '"connection" must be an object or null';
  if (!parseClientConnectionMode(updates.client_connection)) return CLIENT_MODE_ERROR;
  return null;
}

// GET /admin/tokens – list all tokens (token_hash excluded, connection passwords masked)
function listTokens(req, res) {
  sendJson(res, 200, { tokens: loadTokenStore().tokens.map(withoutHash) });
}

// POST /admin/tokens – create new token
async function createToken(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const error = createTokenError(body);
  if (error) return sendJson(res, 400, { error });
  const clientMode = parseClientConnectionMode(body.client_connection);
  const token = crypto.randomBytes(32).toString("hex");
  const store = loadTokenStore();
  const entry = {
    id:           store.next_id++,
    name:         body.name.trim(),
    token_hash:   hashToken(token),
    created_at:   new Date().toISOString(),
    last_used_at: null,
    active:       true,
    connection:   body.connection || null,
    ...(clientMode !== "none" && { client_connection: clientMode }),
  };
  store.tokens.push(entry);
  saveTokenStore(store);
  sendJson(res, 201, { ...withoutHash(entry), token }); // plaintext returned once only
}

// PATCH /admin/tokens/:id – update name, active, connection and/or client_connection
async function updateToken(req, res, id) {
  const updates = JSON.parse(await readBody(req) || "{}");
  const error = updateTokenError(updates);
  if (error) return sendJson(res, 400, { error });
  const store = loadTokenStore();
  const entry = store.tokens.find(t => t.id === id);
  if (!entry) return sendJson(res, 404, { error: "Not found" });
  if (updates.name     !== undefined) entry.name       = updates.name.trim();
  if (updates.active   !== undefined) entry.active     = !!updates.active;
  if (updates.connection !== undefined) entry.connection = mergeSecrets(updates.connection, entry.connection);
  if (updates.client_connection !== undefined) {
    const clientMode = parseClientConnectionMode(updates.client_connection);
    if (clientMode === "none") delete entry.client_connection;
    else entry.client_connection = clientMode;
  }
  saveTokenStore(store);
  sendJson(res, 200, withoutHash(entry));
}

// DELETE /admin/tokens/:id – permanently remove token
function deleteToken(req, res, id, onDelete) {
  const store = loadTokenStore();
  const idx = store.tokens.findIndex(t => t.id === id);
  if (idx === -1) return sendJson(res, 404, { error: "Not found" });
  const [deleted] = store.tokens.splice(idx, 1);
  saveTokenStore(store);
  onDelete?.(deleted);
  sendJson(res, 200, { ok: true, id });
}

// ── Admin: OAuth assignments (/admin/assignments[/:id]) and /admin/me ────────

// GET /admin/assignments – env assignments (read-only) followed by the stored ones; passwords are masked
function listAssignments(req, res) {
  const stored = (loadTokenStore().assignments ?? []).map(a => ({ ...maskConnection(a), source: "store" }));
  sendJson(res, 200, { assignments: [...envAssignments().map(maskConnection), ...stored] });
}

/** Picks the known assignment fields out of a request body. */
const pickAssignment = (body) => Object.fromEntries(ASSIGNMENT_FIELDS.filter(k => body[k] !== undefined).map(k => [k, body[k]]));

// POST /admin/assignments – { group | user, connection, client_connection, admin, note }
async function createAssignment(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const error = assignmentError(body) || (parseClientConnectionMode(body.client_connection) ? null : CLIENT_MODE_ERROR);
  if (error) return sendJson(res, 400, { error });
  const store = loadTokenStore();
  const entry = {
    id: store.next_assignment_id ?? 1,
    ...pickAssignment(body),
    connection: body.connection || null,
    created_at: new Date().toISOString(),
  };
  if (entry.client_connection === "none") delete entry.client_connection;
  store.next_assignment_id = entry.id + 1;
  store.assignments = [...(store.assignments ?? []), entry];
  saveTokenStore(store);
  sendJson(res, 201, { ...maskConnection(entry), source: "store" });
}

// PATCH /admin/assignments/:id – change connection, client_connection, admin, note (not group/user: delete and re-create)
async function updateAssignment(req, res, id) {
  const updates = JSON.parse(await readBody(req) || "{}");
  if (updates.group !== undefined || updates.user !== undefined) {
    return sendJson(res, 400, { error: '"group" and "user" cannot be changed' });
  }
  const error = assignmentError(updates, { partial: true }) || (parseClientConnectionMode(updates.client_connection) ? null : CLIENT_MODE_ERROR);
  if (error) return sendJson(res, 400, { error });
  const store = loadTokenStore();
  const entry = (store.assignments ?? []).find(a => a.id === id);
  if (!entry) return sendJson(res, 404, { error: "Not found" });
  const previous = entry.connection; // Object.assign below replaces it; the stored password must survive a PATCH without one
  Object.assign(entry, pickAssignment(updates));
  if (updates.connection !== undefined) entry.connection = mergeSecrets(updates.connection, previous);
  if (entry.client_connection === "none") delete entry.client_connection;
  saveTokenStore(store);
  sendJson(res, 200, { ...maskConnection(entry), source: "store" });
}

// DELETE /admin/assignments/:id
function deleteAssignment(req, res, id) {
  const store = loadTokenStore();
  const list = store.assignments ?? [];
  const idx = list.findIndex(a => a.id === id);
  if (idx === -1) return sendJson(res, 404, { error: "Not found" });
  list.splice(idx, 1);
  store.assignments = list;
  saveTokenStore(store);
  sendJson(res, 200, { ok: true, id });
}

// GET /admin/me – who is calling and how the server is secured (for the admin UI)
function showMe(req, res, id, onDelete, admin) {
  const oauth = getOAuthConfig();
  sendJson(res, 200, {
    name: admin.name, method: admin.method,
    email: admin.identity?.email ?? null, user_name: admin.identity?.name ?? null,
    oauth: oauth && {
      issuer: oauth.issuer, groups_claim: oauth.groupsClaim, audience: oauth.audience,
      session_ttl: oauth.sessionTtl,
    },
  });
}

const ADMIN_RESOURCES = {
  tokens:      { collection: { GET: listTokens, POST: createToken }, item: { PATCH: updateToken, DELETE: deleteToken } },
  assignments: { collection: { GET: listAssignments, POST: createAssignment }, item: { PATCH: updateAssignment, DELETE: deleteAssignment } },
  me:          { collection: { GET: showMe }, item: {} },
};

export async function handleAdminRequest(req, res, { onDelete } = {}) {
  const admin = await authenticateAdmin(req, res);
  if (!admin.ok) return;

  const pathname = new URL(req.url, "http://x").pathname;
  const match = pathname.match(/^\/admin\/(tokens|assignments|me)(?:\/(\d+))?$/);
  if (!match) return sendJson(res, 404, { error: "Not found" });
  const id = match[2] ? parseInt(match[2], 10) : null;

  const ip = getClientIp(req);
  // Auth disabled → requests are unauthenticated; OAuth → the user's e-mail (or subject) is the actor
  const tokenName = admin.name;
  log("info", "ADMIN", `token="${tokenName}" action="${req.method} ${pathname}" ip="${ip}"`);
  if (admin.identity && !SAFE_METHODS.has(req.method)) {
    audit({ user: admin.identity.display, sub: admin.identity.sub, action: `${req.method} ${pathname}`, ip, via: "oauth-admin" });
  }

  const resource = ADMIN_RESOURCES[match[1]];
  const routes = id ? resource.item : resource.collection;
  const handler = Object.hasOwn(routes, req.method) ? routes[req.method] : null;
  if (!handler) return sendJson(res, 405, { error: "Method Not Allowed" });
  try {
    await handler(req, res, id, onDelete, admin);
  } catch (err) {
    log("error", "ADMIN", `token="${tokenName}" action="${req.method} ${pathname}" ip="${ip}" error=${JSON.stringify(err.message)}`);
    if (err.stack) log("debug", "ADMIN", err.stack);
    sendJson(res, 500, { error: err.message });
  }
}
