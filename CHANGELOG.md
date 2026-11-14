# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-11-14

### Added
- **OAuth 2.0 / OpenID Connect** as an alternative to bearer tokens, primarily for Microsoft Entra ID (any OIDC provider
  works): `OAUTH_ISSUER` switches it on. MCP clients send an access token (JWT: signature via JWKS, issuer, audience,
  lifetime checked), the admin UI offers single sign-on (authorization code + PKCE, `HttpOnly` session cookie, CSRF
  header for changes). `AUTH_TOKEN` and file tokens keep working. See [docs/oauth.md](docs/oauth.md)
- **Assignments** (deny by default): group or e-mail (`*@domain`) → access, **default database connection**,
  `client_connection` mode and admin role. Configured by `OAUTH_ALLOWED_GROUPS`, `OAUTH_ALLOWED_USERS`,
  `OAUTH_ADMIN_GROUPS`, `OAUTH_ADMIN_USERS`, `OAUTH_ASSIGNMENTS` (read-only) and in the admin UI (*OAuth assignments*) /
  REST `/admin/assignments` (stored in the token store, passwords encrypted like token passwords)
- `GET /admin/me`, `GET /auth/status|login|callback`, `POST /auth/logout`, `GET /.well-known/oauth-protected-resource`
  (RFC 9728; `WWW-Authenticate` of the 401 carries `resource_metadata`)
- Audit: new log category `AUDIT` (login/logout, MCP `session_start`, changing admin calls) with e-mail and subject;
  the user's e-mail is the `token` in `MCP`/`SESSION`/`ADMIN` lines and in the database `application_name`;
  `AUTH` `reason="oauth: …"`. Documented in `docs/logging.md`, Logstash pipeline updated
- Helm: `oauth.*` values; OpenAPI: assignment and auth endpoints
- Tests: `tests/skills.integration.test.js` serves every skill as prompt through a real MCP client, runs all SQL
  blocks of the skills read-only on a sample database and checks the skill workflows against real data (sample schema
  documentation, a real blocking chain, idle-in-transaction session, running statement, `pg_stat_statements`
  statistics and plan changes). The compose `postgres-test` service now preloads `pg_stat_statements`
- Tests: `tests/postgres.integration.test.js` runs all tools and the OAuth routing (group/e-mail → database,
  `application_name`, client credentials, audit) against the real `postgres-test` container with sample databases;
  skipped unless `PG_TEST_HOST` is set
- Tests: `tests/oauth*.test.js` (fake provider) and `tests/oidc.integration.test.js` against the
  `oidc-test` container (`docker compose --profile oidc up -d oidc-test`, mock-oauth2-server), skipped unless
  `OIDC_TEST_ISSUER` is set

### Security
- OAuth e-mail matching: an e-mail with `email_verified: false` is ignored, `OAUTH_REQUIRE_VERIFIED_EMAIL` demands
  `true`, and user assignments can name the immutable object id (`oid`/`sub`) instead of an e-mail

### Changed
- With OAuth configured, an empty `AUTH_TOKEN` no longer disables authentication
- `[AUTH]` denials can be HTTP 403 (authenticated, but not assigned / not an admin)

## [1.0.0] - 2026-11-07

First complete version: MCP tools, performance analysis, guided DBA workflows (prompts / skills), multi-user
token management with Admin UI, Docker image and Helm chart on GHCR. Combines the changes previously released as 0.4.1.

### Added
- Guided DBA workflows as **MCP prompts** and **Agent Skills** (`skills/<name>/SKILL.md`, one source for both):
  `pg-activity` (what is my database doing), `pg-top-sessions`, `pg-top-sql`, `pg-locks-waits`, `pg-sql-tuning`,
  `pg-document`, `pg-error-analysis`. The server announces the `prompts` capability; see [docs/skills.md](docs/skills.md)
- Log line `[MCP] action="get_prompt" params={"name":"…"}` for `prompts/get` (argument values are not logged)
- Helm chart is published to the GitHub Container Registry with every release:
  `helm install pg-mcp oci://ghcr.io/tommi2day/charts/pg-mcp-server` (workflow `helm-publish.yml`, also runnable by hand)
- Helm chart icon (`docs/images/icon.svg`, the admin UI database symbol)

### Security
- Updated dependencies (`@modelcontextprotocol/sdk` 1.32.2, `pg` 8.23.1, vitest/eslint/globals); `npm audit fix` clears the
  zod, vite and source-map-js advisories. Production dependencies: 0 known vulnerabilities
- `package.json` overrides `minimatch` to `^11.0.5` (GHSA-g3hv-75wg-m249, pulled in by eslint 10 /
  `@eslint/config-array`) instead of the `npm audit fix --force` downgrade to eslint 9. Dev dependency only;
  `npm audit` reports 0 vulnerabilities
- Docker image runs `apk upgrade` at build time so patched Alpine system libraries (e.g. brotli-libs) are picked up
- Docker image is multi-stage and no longer ships npm/npx/corepack (unused at runtime, carried CVEs in bundled
  brace-expansion/undici); Trivy reports 0 vulnerabilities
- Dockerfile no longer declares an empty `ENV PG_PASSWORD` (Docker build check `SecretsUsedInArgOrEnv`); an unset
  variable behaves the same, compose and Helm still pass it at runtime

### Changed
- Helm chart: the self-signed certificate (no `tls.existingSecret`) includes the Service DNS names (`<svc>`,
  `<svc>.<ns>`, `<svc>.<ns>.svc`, `<svc>.<ns>.svc.<tls.clusterDomain>`), so in-cluster clients can verify it;
  `tls.san` adds to them. New value `tls.clusterDomain` (default `cluster.local`)
- Internal refactoring to keep the cognitive complexity of every function below 15 (Sonar rule S3776): each MCP
  tool is its own function (`TOOL_HANDLERS` in `index.js`), the HTTP router, session start/resume and the admin
  token API (`handleAdminRequest`) are split into small handlers. No change in behavior, API or log output
- `npm run ci:test` also writes `coverage/lcov.info` (coverage limited to `src/`), so SonarQube picks up the test
  coverage instead of reporting 0%

### Fixed
- Admin UI keyboard accessibility (Sonar S1082): Escape closes dialogs via a key handler on the dialog backdrop (the
  dialog gets the focus when it has no input field), and the "Use default connection" toggle can be focused and
  switched with Enter/Space

## [0.4.0] - 2026-09-27

### Added
- Client-supplied connections: a token's `client_connection` (`none` default, `credentials`, `full`) lets its MCP
  clients send their own database user/password — and with `full` host, port, database and ssl — as `X-Pg-*`
  headers on the `initialize` request. Client host/port/database/ssl require client credentials; tokens without an
  own connection keep the server's TLS settings; the permission is re-checked on every request; such sessions get
  their own pool, closed with the last session. `PG_CLIENT_CONNECTION` for the admin token; admin UI, REST API
  (`openapi.json`), `admincli.sh` (`--client-connection`, `set-client-conn`), Helm `postgresql.clientConnection`
- Admin UI branding: `ADMIN_LOGO` (logo file or URL) replaces the icon, `ADMIN_THEME_CSS` loads a stylesheet that
  overrides the color/font variables; all colors of `admin.html` are now CSS variables. Example theme in
  `examples/admin-theme/`, screenshots in the README; Helm values `adminUi.brandingConfigMap` / `themeCss` / `logo`

### Changed
- Source files (`index.js`, `lib.js`, `branding.js`, `admin.html`) moved to `src/`; for local stdio setups the
  entry point is now `node /path/to/src/index.js` (`npm start` and the Docker image are used as before)

## [0.3.0] - 2026-09-25

### Added
- MIT license (`LICENSE`)
- Performance tuning tools: `explain_query`, `top_queries` (`pg_stat_statements`), `table_stats`, `index_health`, `active_queries`, `performance_overview`
  - `explain_query`: `settings` and `generic_plan` (PostgreSQL 16+, plans statements with unbound `$1` placeholders)
  - `top_queries`: `sql_text_like` and `user` filters, `queryid` and role columns, reset time and eviction warning from `pg_stat_statements_info`; the tools' own statements are excluded
  - `table_stats` with `table`: detail view with stale/missing statistics warnings, indexes with definition and usage, per-column planner statistics
  - `active_queries`: blocked sessions first, summary line, `username` and `limit` filters, `query_id`, wait-event snapshot
  - Hints when privileges are missing (`pg_monitor` / `pg_read_all_stats`)
- `docs/performance.md`: privileges, `pg_stat_statements` setup, tool reference, workflows, troubleshooting
- Database sessions carry `application_name` = `<MCP_SERVER_NAME>:<token name>` (e.g. `pg-mcp-server:reporting-team`, `pg-mcp-server:admin`, `pg-mcp-server:stdio`), visible in `pg_stat_activity` and the PostgreSQL log

### Changed
- One database pool per token (and connection) instead of one shared default pool, so each session reports its token in `application_name`. Tokens without their own connection now each get up to 5 connections; idle connections close after 10 s
- stdio mode logs tool calls with `token="stdio"` instead of `token="unknown"`

### Security
- `query` accepts exactly one statement per call (extended query protocol). Previously `COMMIT; <write>` could end the `BEGIN READ ONLY` transaction and run writes through the read-only tool

## [0.2.2] - 2026-09-25

### Added
- `docs/logging.md`: specification of the log line format and tested Filebeat (Docker, Kubernetes) and Logstash configurations in `docs/logging/`.
- `run.sh`: image configurable via `IMAGE` / `IMAGE_TAG`; `run.sh` and `helm_install.sh` read an optional `defaults.env` (site-specific defaults for forks) before `.env`. `helm_install.sh` settings can be overridden from the environment, and `HELM_VALUES_FILES` adds extra values files.
- `package.json`: `ci:*` scripts used by GitLab CI pipelines.
- `DOCKERHUB.md`: compact description for Docker Hub (features, comparison, quick start, screenshots). The new workflow *Docker Hub Description* publishes it whenever it changes on `main` or on manual dispatch.

### Changed
- `ci:test` prints a coverage summary, so GitLab CI can show test coverage.
- README / Docker Hub: query plans (`EXPLAIN`, `EXPLAIN ANALYZE`) are available through `query`; the comparison with Postgres MCP Pro now names what is actually missing (index recommendations with hypothetical indexes, `pg_stat_statements` workload analysis, health checks).

### Fixed
- `query`: `json` / `jsonb` values — including `EXPLAIN (FORMAT JSON)` plans — were rendered as `[object Object]`; they are now output as JSON.

## [0.2.1] - 2026-09-25

### Fixed
- Admin UI: the `.mcp.json` hint in the *Token Created* dialog overflowed the dialog, because the long bearer token could not wrap.

### Added
- README: screenshots of the admin UI and of the log output (`docs/images/`).

### Changed
- Updated `pg` to `^8.23.0` and dev dependencies (`vitest` / `@vitest/coverage-v8` `^5.0.1`, `globals`); lockfile refreshed with `npm audit fix` (0 vulnerabilities).

## [0.2.0] - 2026-09-25

### Added
- `LOG_LEVEL` env var (`debug` / `info` / `warn` / `error`, default `info`); exposed in `.env.example`, `docker-compose.yml` and the Helm chart (`server.logLevel`). The active level is shown in the startup banner.
- Audit log for rejected requests (`[WARN] [AUTH]`) with path, client IP and reason: `missing token`, `invalid admin token`, `unknown token` or `token disabled` (incl. token name). The presented token is never logged.
- Audit log for MCP session start and stop (`[INFO] [SESSION]`) with token name, session ID, client IP and duration.
- docker-compose: named volume `mcp-certs` at `/certs` so TLS certificates persist next to the token store (`mcp-data`).
- docker-compose: fixed container hostname (`MCP_HOSTNAME`, default `pg-mcp-server`) so the SAN of the persisted self-signed certificate stays valid when the container is re-created.
- `run.sh`: mounts the volume `<name>-certs` at `/certs` and passes `TLS_ENABLED`, `TLS_SAN`, `LOG_LEVEL` and `STORE_ENCRYPTION_KEY` from `.env`.
- Entrypoint: a self-signed certificate generated by the server (`CN=pg-mcp-server`) is regenerated when it expires within 30 days. User-provided certificates are never replaced.
- README: feature overview and comparison with other PostgreSQL MCP servers.

### Changed
- **Log format:** every line now carries a level: `[timestamp] [LEVEL] [CATEGORY] message`. Update log parsers or alert rules that match the old `[timestamp] [CATEGORY]` format.
- The SQL text of `query` / `execute` tool calls is only logged at `debug`. At `info` it is replaced by its length (`<N chars, LOG_LEVEL=debug to show>`).
- Admin API log lines show `token="anonymous"` instead of `token="admin"` when `AUTH_TOKEN` is not set.
- Stack traces of admin API errors are logged at `debug` only.
- Updated `@modelcontextprotocol/sdk` to `^1.30.0`.
- Helm: with `server.tlsEnabled: true`, the `httpGet` liveness and readiness probes default to `scheme: HTTPS`. An explicit `scheme` in the values still takes precedence.

### Fixed
- Release workflow: pushing a version tag skipped the *Build & Push* and *Create Release* jobs, because the skipped *Bump version* job made their implicit `success()` check fail. Both jobs now run on tag push as well as on manual dispatch.
- Container crash loop with HTTPS on Kubernetes when the certificate comes from a Secret (`tls.existingSecret` or `tls.cert`/`tls.key`). The entrypoint ran `chmod o+r` on the read-only Secret mount and exited when it failed.
- Helm: with TLS enabled, the health probes used HTTP and failed unless `scheme: HTTPS` was set by hand.
- The session close handler overwrote the `onclose` handler installed by `server.connect()` instead of chaining it.

### Security
- Dependency updates via `npm audit fix` for advisories in `hono`, `@hono/node-server`, `ip-address`, `qs` (runtime, via the MCP SDK) and `brace-expansion`, `fast-uri`, `nanoid`, `postcss`, `@humanfs/node` (dev tooling); `vitest` / `@vitest/coverage-v8` raised to `^4.1.11`. `npm audit` reports 0 vulnerabilities.
- The TLS private key is no longer made world-readable by the entrypoint. A key owned by uid 1000 is set to mode `640`, which also repairs keys that earlier versions left at `644` in a persistent volume.
- Helm: the TLS Secret and the PostgreSQL client-certificate Secret are mounted with `defaultMode: 0440` (readable by root and `fsGroup` 1000 only).
- `run.sh` now passes `STORE_ENCRYPTION_KEY`, so connection passwords are no longer stored in plaintext when the container is started through this script.

## [0.1.6] - 2026-07-21

### Changed
- Container runs as `node` (uid 1000) from the start; no root step in the entrypoint. `/certs` and `/data` are pre-owned by uid 1000, mounted volumes must be writable by uid 1000 (Helm sets `fsGroup: 1000`).
- Simplified TLS certificate handling in the entrypoint.

## [0.1.5] - 2026-07-21

### Added
- Integration tests workflow and `npm audit` step in CI.

### Changed
- Updated `body-parser` to v2.3.0 and related dependencies.
- Dependabot runs monthly instead of weekly; automerge workflow refined.

## [0.1.4] - 2026-07-20

### Added
- `npm audit` scripts.

### Changed
- PostgreSQL SSL configuration in `docker-compose.yml` refined.
- Updated dependencies and GitHub Actions (`actions/checkout`, `actions/setup-node`, `codecov/codecov-action`).

## [0.1.3] - 2026-05-03

### Added
- Caching of the token store, request body size limit (1 MB) and input validation for the admin API.

## [0.1.2] - 2026-05-03

### Changed
- Admin UI fetches server info asynchronously from the `/info` endpoint instead of inlined placeholders.

## [0.1.1] - 2026-05-03

### Added
- `MCP_SERVER_NAME` support in `run.sh`.

### Changed
- Server info integrated into the Admin UI.

## [0.1.0] - 2026-05-03

### Added
- AES-256-GCM encryption of stored connection passwords (`STORE_ENCRYPTION_KEY`) with automatic migration of plaintext passwords.
- Configurable server name (`MCP_SERVER_NAME`) shown in MCP clients and the Admin UI.
- README: MCP client configuration for Claude Code CLI, VS Code and OpenCode.

### Fixed
- Syntax errors in OpenAPI examples.

## [0.0.13] - 2026-04-26

### Changed
- Deleting a token removes it permanently.

## [0.0.12] - 2026-04-26

### Added
- README: Traefik reverse proxy setup (host- and path-based routing).

### Fixed
- Environment variables in `run.sh` are quoted.
- Token store directory is writable before privileges are dropped in the entrypoint.

## [0.0.11] - 2026-04-26

### Added
- Default DB connection handling and connection toggle in the Admin UI.

### Changed
- `token.sh` replaced by `admincli.sh`.

## [0.0.10] - 2026-04-24

### Added
- Structured error logging for admin API, DB pools, MCP, HTTP requests and process-level errors.
- `health` and `info` commands and more subcommands in the token CLI.
- README: HTTPS requirement for Claude Desktop with configuration examples and troubleshooting.

## [0.0.9] - 2026-04-04

### Added
- `/info` endpoint with server version and sanitized database connection info.

## [0.0.8] - 2026-04-04

### Changed
- Test cleanup (`afterAll`) and shared pool/session exports for tests.

## [0.0.7] - 2026-04-03

### Added
- File-based token store, per-token database connections and web Admin UI.
- `.env.example` workflow documentation.

## [0.0.6] - 2026-03-28

### Changed
- Helm chart version synced with `package.json`; ports renamed to `http`.
- `test_token.sh` sends an `X-Real-IP` header.

## [0.0.5] - 2026-03-28

### Added
- `openapi.json` describing the health, MCP and admin endpoints; version kept in sync with `package.json`.

### Changed
- Improved client IP resolution.

## [0.0.4] - 2026-03-28

### Added
- Client IP in MCP request logs.

## [0.0.3] - 2026-03-28

### Added
- HTTP session management and connection logging.
- `test_token.sh` for validating tokens.

## [0.0.2] - 2026-03-28

### Added
- `PG_SSL=prefer` handling; `PG_SSL` configurable in `run.sh`.

## [0.0.1] - 2026-03-28

### Added
- Initial release: PostgreSQL MCP server with stdio and HTTP(S) transport, Docker image, Helm chart, `run.sh` and coverage scripts, CI and release workflows.

[Unreleased]: https://github.com/Tommi2Day/pg-mcp-server/compare/1.1.0...HEAD
[1.1.0]: https://github.com/Tommi2Day/pg-mcp-server/compare/1.0.0...1.1.0
[1.0.0]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.4.0...1.0.0
[0.4.0]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.2.2...0.3.0
[0.2.2]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.2.1...0.2.2
[0.2.1]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.2.0...0.2.1
[0.2.0]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.1.6...0.2.0
[0.1.6]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.1.5...0.1.6
[0.1.5]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.1.4...0.1.5
[0.1.4]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.1.3...0.1.4
[0.1.3]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.1.2...0.1.3
[0.1.2]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.1.0...0.1.1
[0.1.0]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.13...0.1.0
[0.0.13]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.12...0.0.13
[0.0.12]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.11...0.0.12
[0.0.11]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.10...0.0.11
[0.0.10]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.9...0.0.10
[0.0.9]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.8...0.0.9
[0.0.8]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.7...0.0.8
[0.0.7]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.6...0.0.7
[0.0.6]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.5...0.0.6
[0.0.5]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.4...0.0.5
[0.0.4]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.3...0.0.4
[0.0.3]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.2...0.0.3
[0.0.2]: https://github.com/Tommi2Day/pg-mcp-server/compare/0.0.1...0.0.2
[0.0.1]: https://github.com/Tommi2Day/pg-mcp-server/releases/tag/0.0.1
