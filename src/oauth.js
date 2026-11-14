/**
 * OAuth 2.0 / OpenID Connect support (Microsoft Entra ID first, any OIDC provider works).
 * Pure helpers — no MCP SDK and no lib.js imports (lib.js imports this module and does the logging).
 *
 *  - bearer access tokens (JWT) are validated against the issuer's JWKS (RS*, PS*, ES*)
 *  - identity (email, groups) comes from token claims
 *  - assignments (group / user → default connection, admin) decide who may use the server
 *  - browser login for the admin UI: authorization code flow with PKCE, server-side session cookie
 */
import crypto from "node:crypto";

export class OAuthError extends Error {}

const csv = (v) => String(v || "").split(",").map(s => s.trim()).filter(Boolean);
const stripSlash = (s) => String(s).replace(/\/+$/, "");

// ── Configuration (environment, read on every call) ──────────────────────────
/** OAuth configuration from OAUTH_* env vars; null when OAUTH_ISSUER is not set (OAuth disabled). */
export function getOAuthConfig() {
  const issuer = stripSlash((process.env.OAUTH_ISSUER || "").trim());
  if (!issuer) return null;
  const clientId = (process.env.OAUTH_CLIENT_ID || "").trim();
  const publicUrl = stripSlash((process.env.OAUTH_PUBLIC_URL || "").trim());
  const ttl = parseInt(process.env.OAUTH_SESSION_TTL || "28800", 10);
  return {
    issuer,
    issuers: (csv(process.env.OAUTH_ALLOWED_ISSUERS).length ? csv(process.env.OAUTH_ALLOWED_ISSUERS) : [issuer]).map(stripSlash),
    audience: csv(process.env.OAUTH_AUDIENCE).length ? csv(process.env.OAUTH_AUDIENCE) : (clientId ? [clientId] : []),
    clientId,
    clientSecret: process.env.OAUTH_CLIENT_SECRET || "",
    publicUrl,
    redirectUri: (process.env.OAUTH_REDIRECT_URI || "").trim() || (publicUrl ? `${publicUrl}/auth/callback` : ""),
    scopes: (process.env.OAUTH_SCOPES || "openid profile email").trim(),
    /** Scopes advertised to MCP clients in the protected-resource metadata (default `<audience>/.default`, right for Entra ID). */
    resourceScopes: resourceScopes(),
    groupsClaim: (process.env.OAUTH_GROUPS_CLAIM || "groups").trim(),
    emailClaim: (process.env.OAUTH_EMAIL_CLAIM || "").trim(),
    requireVerifiedEmail: /^(1|true|yes)$/i.test(process.env.OAUTH_REQUIRE_VERIFIED_EMAIL || ""),
    jwksUri: (process.env.OAUTH_JWKS_URI || "").trim(),
    authorizationEndpoint: (process.env.OAUTH_AUTHORIZATION_ENDPOINT || "").trim(),
    tokenEndpoint: (process.env.OAUTH_TOKEN_ENDPOINT || "").trim(),
    sessionTtl: Number.isFinite(ttl) && ttl > 0 ? ttl : 28800,
  };
}

function resourceScopes() {
  const given = (process.env.OAUTH_RESOURCE_SCOPES || "").split(/[\s,]+/).filter(Boolean);
  return given.length ? given : null;
}

/** Human readable configuration errors (empty list = usable). */
export function oauthConfigProblems(config = getOAuthConfig()) {
  if (!config) return [];
  const problems = [];
  if (!config.audience.length) problems.push("OAUTH_AUDIENCE or OAUTH_CLIENT_ID is required to validate access tokens");
  if (config.clientId && !config.redirectUri) problems.push("browser login needs OAUTH_PUBLIC_URL or OAUTH_REDIRECT_URI");
  return problems;
}

/** Browser login (admin UI) is only offered with a client id and a redirect URI. */
export const browserLoginEnabled = (config) => !!(config && config.clientId && config.redirectUri);

// ── Provider metadata and signing keys ───────────────────────────────────────
const META_TTL_MS = 3600_000;
const JWKS_REFRESH_MS = 30_000;
const FETCH_TIMEOUT_MS = 5000;
let metaCache = null;   // { key, at, value }
let jwksCache = null;   // { uri, at, keys: Map<kid, KeyObject> }

export function clearOAuthCache() {
  metaCache = null; jwksCache = null;
  pendingLogins.clear(); sessions.clear();
}

async function fetchJson(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new OAuthError(`cannot reach ${new URL(url).host}: ${e.message}`, { cause: e });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new OAuthError(body.error_description || body.error || `HTTP ${res.status} from ${new URL(url).host}`);
  return body;
}

/** OIDC discovery document (cached 1 h); explicit OAUTH_*_ENDPOINT settings win. */
export async function getMetadata(config) {
  const explicit = config.jwksUri && config.authorizationEndpoint && config.tokenEndpoint;
  const base = explicit ? {} : await discover(config);
  return {
    jwks_uri: config.jwksUri || base.jwks_uri,
    authorization_endpoint: config.authorizationEndpoint || base.authorization_endpoint,
    token_endpoint: config.tokenEndpoint || base.token_endpoint,
  };
}

async function discover(config) {
  if (metaCache && metaCache.key === config.issuer && Date.now() - metaCache.at < META_TTL_MS) return metaCache.value;
  const value = await fetchJson(`${config.issuer}/.well-known/openid-configuration`);
  metaCache = { key: config.issuer, at: Date.now(), value };
  return value;
}

async function loadJwks(uri) {
  const { keys = [] } = await fetchJson(uri);
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.use && jwk.use !== "sig") continue;
    try { map.set(jwk.kid ?? "", crypto.createPublicKey({ key: jwk, format: "jwk" })); } catch { /* unsupported key */ }
  }
  jwksCache = { uri, at: Date.now(), keys: map };
  return map;
}

/** Signing key by `kid`; the key set is refreshed (at most every 30 s) when the kid is unknown (key rotation). */
async function getSigningKey(config, kid = "") {
  const { jwks_uri: uri } = await getMetadata(config);
  if (!uri) throw new OAuthError("issuer has no jwks_uri");
  const cached = jwksCache && jwksCache.uri === uri ? jwksCache : null;
  let key = cached?.keys.get(kid) ?? (cached?.keys.size === 1 && !kid ? [...cached.keys.values()][0] : undefined);
  if (!key && (!cached || Date.now() - cached.at > JWKS_REFRESH_MS)) {
    const keys = await loadJwks(uri);
    key = keys.get(kid) ?? (keys.size === 1 && !kid ? [...keys.values()][0] : undefined);
  }
  if (!key) throw new OAuthError("signing key not found");
  return key;
}

// ── JWT validation ───────────────────────────────────────────────────────────
const ALGORITHMS = {
  RS256: { hash: "sha256" }, RS384: { hash: "sha384" }, RS512: { hash: "sha512" },
  PS256: { hash: "sha256", pss: true }, PS384: { hash: "sha384", pss: true }, PS512: { hash: "sha512", pss: true },
  ES256: { hash: "sha256", ec: true }, ES384: { hash: "sha384", ec: true },
};
const CLOCK_SKEW_S = 60;

const b64json = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** True for strings shaped like a compact JWT (three base64url parts). */
export const looksLikeJwt = (token) => /^[\w-]+\.[\w-]+\.[\w-]*$/.test(token || "");

export function decodeJwt(token) {
  if (!looksLikeJwt(token)) throw new OAuthError("not a JWT");
  const [h, p, s] = token.split(".");
  try {
    return { header: b64json(h), payload: b64json(p), signature: Buffer.from(s, "base64url"), signingInput: `${h}.${p}` };
  } catch (e) {
    throw new OAuthError("malformed JWT", { cause: e });
  }
}

function verifySignature(jwt, key) {
  const alg = ALGORITHMS[jwt.header.alg]; // "none" and HS* are not in the table and never accepted
  if (!alg) throw new OAuthError(`unsupported algorithm ${JSON.stringify(String(jwt.header.alg))}`);
  const input = Buffer.from(jwt.signingInput);
  let options = key;
  if (alg.pss) options = { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST };
  if (alg.ec) options = { key, dsaEncoding: "ieee-p1363" };
  let ok = false;
  try { ok = crypto.verify(alg.hash, input, options, jwt.signature); } catch { /* key type does not match alg */ }
  if (!ok) throw new OAuthError("invalid signature");
}

function checkTimes(p, now) {
  if (typeof p.exp !== "number") throw new OAuthError("token has no exp claim");
  if (now > p.exp + CLOCK_SKEW_S) throw new OAuthError("token expired");
  if (typeof p.nbf === "number" && now < p.nbf - CLOCK_SKEW_S) throw new OAuthError("token not yet valid");
}

function checkClaims(p, config, { audience, nonce }) {
  checkTimes(p, Math.floor(Date.now() / 1000));
  if (!config.issuers.includes(stripSlash(String(p.iss || "")))) throw new OAuthError("issuer not accepted");
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!audience.length || !aud.some(a => audience.includes(a))) throw new OAuthError("audience not accepted");
  if (nonce !== undefined && p.nonce !== nonce) throw new OAuthError("nonce mismatch");
}

/** Verifies signature, issuer, audience and lifetime; returns the claims. Throws OAuthError. */
export async function verifyJwt(token, config, { audience = config.audience, nonce } = {}) {
  const jwt = decodeJwt(token);
  const key = await getSigningKey(config, jwt.header.kid);
  verifySignature(jwt, key);
  checkClaims(jwt.payload, config, { audience, nonce });
  return jwt.payload;
}

// ── Identity ─────────────────────────────────────────────────────────────────
const getClaim = (payload, path) => (path in payload ? payload[path] : path.split(".").reduce((o, k) => o?.[k], payload));
const firstString = (values) => values.find(v => typeof v === "string" && v.trim());

/** Printable, quote-free value for log lines and application_name. */
export const safeLogValue = (s, max = 128) => String(s ?? "").replace(/[^\x20-\x7e]|["\\]/g, "?").slice(0, max);

/** { sub, email, name, display, groups[], groupsOverage } from validated claims. */
export function identityFromClaims(payload, config) {
  // An e-mail the provider marks as unverified (or, with OAUTH_REQUIRE_VERIFIED_EMAIL, not verified) is never used for matching
  const emailOk = payload.email_verified === true || (payload.email_verified !== false && !config.requireVerifiedEmail);
  const email = emailOk
    ? firstString([config.emailClaim && getClaim(payload, config.emailClaim), payload.email, payload.preferred_username, payload.upn])?.trim().toLowerCase()
    : undefined;
  const raw = getClaim(payload, config.groupsClaim);
  const groups = (Array.isArray(raw) ? raw : [raw]).filter(g => typeof g === "string" && g).map(g => g.toLowerCase());
  const sub = String(payload.oid || payload.sub || payload.azp || "");
  return {
    sub, email: email || null, name: typeof payload.name === "string" ? payload.name : null,
    display: safeLogValue(email || sub || "unknown"),
    groups,
    // Entra: more than ~200 groups are not put into the token (only a pointer to Graph)
    groupsOverage: !!(payload._claim_names?.groups || payload.hasgroups),
  };
}

// ── Assignments (who may use the server, with which default connection) ──────
/** What an assignment may contain: group xor user, connection (object|null), client_connection, admin. */
export const ASSIGNMENT_FIELDS = ["group", "user", "connection", "client_connection", "admin", "note"];

function envJsonAssignments() {
  const raw = process.env.OAUTH_ASSIGNMENTS;
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch (e) { throw new OAuthError(`OAUTH_ASSIGNMENTS is not valid JSON: ${e.message}`, { cause: e }); }
  if (!Array.isArray(list)) throw new OAuthError("OAUTH_ASSIGNMENTS must be a JSON array");
  return list;
}

/** Assignments from env: OAUTH_ASSIGNMENTS (JSON array), OAUTH_ALLOWED_GROUPS / OAUTH_ALLOWED_USERS and
 *  OAUTH_ADMIN_GROUPS / OAUTH_ADMIN_USERS (comma lists, default connection). Read-only in the admin UI. */
export function envAssignments() {
  const simple = [
    ...csv(process.env.OAUTH_ALLOWED_GROUPS).map(group => ({ group })),
    ...csv(process.env.OAUTH_ALLOWED_USERS).map(user => ({ user })),
    ...csv(process.env.OAUTH_ADMIN_GROUPS).map(group => ({ group, admin: true })),
    ...csv(process.env.OAUTH_ADMIN_USERS).map(user => ({ user, admin: true })),
  ];
  return [...envJsonAssignments(), ...simple].map((a, i) => ({
    ...a, id: `env-${i + 1}`, source: "env", connection: a.connection ?? null,
  }));
}

/** Validation error text for an assignment body (create), or null. */
export function assignmentError(a, { partial = false } = {}) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return "assignment must be an object";
  const hasGroup = a.group !== undefined && a.group !== null && a.group !== "";
  const hasUser = a.user !== undefined && a.user !== null && a.user !== "";
  if (!partial && hasGroup === hasUser) return 'exactly one of "group" or "user" is required';
  if (hasGroup && hasUser) return 'only one of "group" or "user" may be set';
  if ((hasGroup && (typeof a.group !== "string" || !a.group.trim())) || (hasUser && (typeof a.user !== "string" || !a.user.trim()))) {
    return '"group" and "user" must be non-empty strings';
  }
  if (a.connection !== undefined && a.connection !== null && (typeof a.connection !== "object" || Array.isArray(a.connection))) {
    return '"connection" must be an object or null';
  }
  if (a.admin !== undefined && typeof a.admin !== "boolean") return '"admin" must be true or false';
  return null;
}

const lc = (s) => String(s).trim().toLowerCase();

/** user "alice@x.com" matches exactly; "*@x.com" matches the whole domain. Returns specificity (2 exact, 1 domain, 0 none). */
function userMatch(pattern, identity) {
  const p = lc(pattern);
  if (identity.sub && p === lc(identity.sub)) return 2; // immutable object id (Entra oid): safest way to name a user
  const email = identity.email;
  if (!email) return 0;
  if (p === email) return 2;
  return p.startsWith("*@") && email.endsWith(p.slice(1)) ? 1 : 0;
}

function matchRank(a, identity) {
  if (a.user) return 10 + userMatch(a.user, identity); // 10 = no match
  if (a.group && identity.groups.includes(lc(a.group))) return 1;
  return 0;
}

/**
 * Access decision for an identity.
 *  allowed  – at least one assignment matches (OAuth is deny-by-default)
 *  admin    – a matching assignment has admin:true
 *  connection / clientConnection / assignment – from the best matching assignment that sets a
 *    connection: exact user, then domain pattern, then group (in list order: env first, then the store);
 *    without any, the server default connection (null).
 */
export function resolveAccess(identity, assignments) {
  const scored = [];
  assignments.forEach((a, order) => {
    const rank = matchRank(a, identity);
    if (rank === 12) scored.push({ a, order, priority: 0 });
    else if (rank === 11) scored.push({ a, order, priority: 1 });
    else if (rank === 1) scored.push({ a, order, priority: 2 });
  });
  if (!scored.length) return { allowed: false, admin: false };
  scored.sort((x, y) => x.priority - y.priority || x.order - y.order);
  const primary = scored.find(s => s.a.connection) ?? scored[0];
  return {
    allowed: true,
    admin: scored.some(s => s.a.admin === true),
    connection: primary.a.connection ?? null,
    clientConnection: primary.a.client_connection ?? "none",
    assignment: String(primary.a.id ?? ""),
  };
}

// ── Browser login (authorization code + PKCE) and sessions ───────────────────
const LOGIN_TTL_MS = 600_000;
const MAX_ENTRIES = 5000;
const pendingLogins = new Map(); // state → { verifier, nonce, at, returnTo }
const sessions = new Map();      // session id → { identity, expires }

const randomToken = (n = 32) => crypto.randomBytes(n).toString("base64url");

function prune(map, isExpired) {
  for (const [k, v] of map) if (isExpired(v)) map.delete(k);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

/** Authorization URL for the redirect to the identity provider. */
export async function startLogin(config, returnTo = "/admin") {
  const { authorization_endpoint: endpoint } = await getMetadata(config);
  if (!endpoint) throw new OAuthError("issuer has no authorization_endpoint");
  prune(pendingLogins, v => Date.now() - v.at > LOGIN_TTL_MS);
  const state = randomToken(); const nonce = randomToken(); const verifier = randomToken(48);
  pendingLogins.set(state, { verifier, nonce, at: Date.now(), returnTo });
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId, response_type: "code", redirect_uri: config.redirectUri,
    scope: config.scopes, state, nonce, response_mode: "query",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Completes the login: state check, code exchange, id_token validation. Returns { identity, returnTo }. */
export async function finishLogin(config, { code, state }) {
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state); // single use
  if (!pending || Date.now() - pending.at > LOGIN_TTL_MS) throw new OAuthError("unknown or expired login state");
  if (!code) throw new OAuthError("no authorization code");
  const { token_endpoint: endpoint } = await getMetadata(config);
  const form = new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: config.redirectUri,
    client_id: config.clientId, code_verifier: pending.verifier,
  });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);
  const tokens = await fetchJson(endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form,
  });
  if (!tokens.id_token) throw new OAuthError("provider returned no id_token");
  const claims = await verifyJwt(tokens.id_token, config, { audience: [config.clientId], nonce: pending.nonce });
  return { identity: identityFromClaims(claims, config), returnTo: pending.returnTo };
}

export function createSession(config, identity) {
  prune(sessions, v => Date.now() > v.expires);
  const id = randomToken();
  sessions.set(id, { identity, expires: Date.now() + config.sessionTtl * 1000 });
  return id;
}

export function destroySession(id) { return sessions.delete(id); }

export const SESSION_COOKIE = "pgmcp_session";

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Identity of the browser session cookie, or null (unknown / expired). */
export function sessionFromRequest(req) {
  const id = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
  const s = id && sessions.get(id);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(id); return null; }
  return { id, identity: s.identity };
}

/** Set-Cookie value; maxAge 0 clears the cookie. Secure when the public URL is https. */
export function sessionCookie(config, value, maxAge) {
  const secure = /^https:/i.test(config.publicUrl || config.redirectUri) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
