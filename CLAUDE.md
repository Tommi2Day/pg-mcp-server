# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Scripts in `scripts/` require only Docker. `npm` commands require local Node.js.

```bash
# Tests
./scripts/test.sh                          # all tests (Docker)
./scripts/test.sh tests/lib.test.js        # single file (Docker)
npm test                                   # all tests (local Node.js)
npm run test:watch                         # watch mode

# Coverage
./scripts/coverage.sh                      # report → ./coverage/
./scripts/coverage.sh --open               # coverage + open in browser

# Lint
./scripts/lint.sh                          # check (Docker)
./scripts/lint.sh --fix                    # auto-fix (Docker)
npm run lint / npm run lint:fix            # local

# Run server locally
npm start                                  # stdio mode
npm run start:http                         # HTTP mode (TRANSPORT=http)

# Docker
./scripts/run.sh                           # pull + start container; auto-generates auth_token
docker compose up -d                       # MCP server + postgres-test container
docker compose down

# Token management
./scripts/token.sh list|add|delete|enable|disable|rename|setconn|clearconn
./scripts/test_token.sh <token> [schema]   # validate token + list tables

# Helm
helm install pg-mcp ./helm/pg-mcp-server --namespace mcp --create-namespace -f my-values.yaml
helm upgrade pg-mcp ./helm/pg-mcp-server -n mcp -f my-values.yaml
```

## Architecture

**Two source files, no build step:**

- **`lib.js`** — all pure, independently testable logic. No MCP SDK imports. Exports: `buildPgSsl`, `getAuthToken`, `hashToken`, `extractBearer`, `send401`, `readBody`, `checkAdminAuth`, `checkAuth`, `handleAdminRequest`, `loadTokenStore`, `saveTokenStore`, `getTokensFile`.
- **`index.js`** — MCP server factory, HTTP router, startup. Imports only from `lib.js` and external packages. Exports `createMcpServer`, `handleRequest`, `getPool` for tests.
- **`admin.html`** — single-file SPA served at `GET /admin`. No external dependencies. Reads its path via `new URL("./admin.html", import.meta.url)` (ESM — no `__dirname`).

### isMain guard

```js
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
```

Pool creation and all startup code live inside `if (isMain)`. This prevents side effects when `index.js` is imported by tests.

### Token store (file-based)

Tokens are stored in a JSON file (`TOKENS_FILE` env var, default `./tokens.json`). The file is read/written synchronously by `loadTokenStore()` / `saveTokenStore()` in `lib.js`. There is no database table for tokens — `initTokenTable` no longer exists.

Each token record has: `id`, `name`, `token_hash` (SHA-256 hex), `created_at`, `last_used_at`, `active`, `connection` (object or null). The `token_hash` field is never returned by the admin API.

### Auth (two levels)

- **`AUTH_TOKEN`** env var — admin token; accepted at `/mcp` and `/admin/tokens`
- **File tokens** — accepted at `/mcp` only; looked up by SHA-256 hash in the token store
- `AUTH_TOKEN` empty → auth disabled; all requests (including admin API) are allowed without a token
- `checkAuth(req, res)` returns `{ ok, name, connection }` — mocks must return this shape
- `checkAdminAuth(req, res)` returns `true` when `AUTH_TOKEN` is not set (mirrors `checkAuth` behaviour)

### Per-token connection routing

`checkAuth` returns the token's `connection` object (or `null`). `handleRequest` passes it to `getPool(connection)` in `index.js`, which returns a cached `pg.Pool` for that connection config, or the default admin pool when `connection` is null. Pool instances are cached in a module-level `Map` keyed by `JSON.stringify(connection)`.

### HTTP session management

`handleRequest` keeps a module-level `sessions` Map (`sessionId → StreamableHTTPServerTransport`). First `/mcp` request (no `mcp-session-id` header) creates a new session via `onsessioninitialized`; subsequent requests reuse the cached transport. The pool is resolved at session-creation time and stays fixed for the session's lifetime.

### Transport modes (`TRANSPORT` env var)

- `stdio` (default) — Claude Desktop; no HTTP, no auth, no session management
- `http` — HTTP or HTTPS; enables auth, admin API, session management

### Logging

```
[ISO timestamp] [MCP]   token="<name>" action="<tool>" ip="<ip>" params={...}
[ISO timestamp] [ADMIN] token="admin"  action="<METHOD> <path>" ip="<ip>"
```

Token name is `"admin"` for the env token, `"anonymous"` when auth is disabled, or the file token's `name` field. `clientIp` resolved: `x-real-ip` → `x-forwarded-for` first entry → socket address.

### Docker entrypoint

`docker-entrypoint.sh` runs as root, handles TLS certs (generates self-signed if `/certs` is empty), then `exec su-exec node node index.js` (drops to uid 1000). Token store persistence requires a volume mounted at the `TOKENS_FILE` directory (default `/data`).

### Helm chart (`helm/pg-mcp-server/`)

Key values:
- `auth.token` / `auth.existingSecret` → Secret `<release>-auth`
- `postgresql.existingSecret` → Secret `<release>-pg-credentials`
- `tls.existingSecret` / `tls.cert` + `tls.key` → HTTPS
- `tls.san` → `TLS_SAN` env var (additional SANs for self-signed cert)
- `server.tlsEnabled: true` → switches health probe scheme to HTTPS
- `persistence.enabled: true` → creates a PVC for the token store; `persistence.existingClaim` to use a pre-existing one
- Service and container port are named `http` (ingress uses this name — must match)

### docker-compose

Two services on `mcp-net`: `postgres-test` (port 5433, `pg_isready` healthcheck) and `pg-mcp-server` (`depends_on: condition: service_healthy`). Named volume `mcp-data` mounts at `/data` to persist `tokens.json`.

## Tests

Three test files in `tests/`:
- `lib.test.js` — unit tests for all `lib.js` exports; mocks `node:fs` for token store tests
- `admin.test.js` — `handleAdminRequest` CRUD; mocks `node:fs` (`readFileSync`/`writeFileSync`) via `vi.hoisted`
- `index.test.js` — `handleRequest` routing, `getPool` caching, `createMcpServer` ListTools + CallTool (all 6 tools)

`index.test.js` mocks `pg`, all MCP SDK modules, and `lib.js`. `capturedHandlers` (hoisted) captures `setRequestHandler` callbacks so tool handlers can be invoked directly in tests.

`admin.test.js` and `lib.test.js` mock `node:fs` with `vi.hoisted` so `lib.js`'s internal `readFileSync`/`writeFileSync` calls are intercepted. Use `mockReadFile.mockReturnValueOnce(JSON.stringify(store))` to seed the store and `mockWriteFile.mock.calls[0][1]` to inspect what was written.

## Version sync

Three files are always kept in sync: `package.json`, `openapi.json` (`info.version`), and `helm/pg-mcp-server/Chart.yaml` (`version` + `appVersion`).

**Option 1 — local:** `npm version 1.2.3` triggers the `version` lifecycle script, then `git push origin main 1.2.3`.

**Option 2 — CI:** trigger **Actions → Release → Run workflow** with a version number.
