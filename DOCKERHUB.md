# PostgreSQL MCP Server

Connects AI assistants (Claude, Copilot, …) to PostgreSQL via the Model Context Protocol (MCP) — as a central, multi-user service with token authentication, per-token database connections and audit logging.

**Source, full documentation, Helm chart:** [github.com/Tommi2Day/pg-mcp-server](https://github.com/Tommi2Day/pg-mcp-server) · **Changelog:** [CHANGELOG.md](https://github.com/Tommi2Day/pg-mcp-server/blob/main/CHANGELOG.md)

## Features

**MCP tools**
- 6 tools: `test_connection`, `list_schemas`, `list_tables`, `describe_table`, `query`, `execute`
- `query` runs inside `BEGIN READ ONLY` — PostgreSQL itself rejects writes, not a keyword filter
- `execute` runs in a transaction with automatic `ROLLBACK` on error
- Parameterized queries (`params`), results capped at 200 rows to keep LLM context small

**Multi-user & access control**
- Bearer-token authentication with two levels: admin token (`AUTH_TOKEN`) and any number of client tokens
- **Per-token database connection** — one server instance serves several databases / DB users; each token is routed to its own connection pool
- Tokens can be created, renamed, disabled and deleted at runtime — via **web Admin UI** (`/admin`, [screenshots](https://github.com/Tommi2Day/pg-mcp-server#admin-ui)), REST API (OpenAPI spec included) or `admincli.sh`
- Tokens stored only as SHA-256 hashes, constant-time comparison; per-token DB passwords encrypted at rest (AES-256-GCM, `STORE_ENCRYPTION_KEY`)

**Security & transport**
- stdio (Claude Desktop / Claude Code) or Streamable HTTP with session management
- HTTPS with own certificates, auto-generated self-signed certs (renewed before expiry) and optional **mTLS** for clients
- TLS to PostgreSQL incl. server-cert verification (`PG_SSL=verify`) and client certificates
- Container runs as non-root (uid 1000), no privilege escalation, all capabilities dropped in Kubernetes

**Audit logging**
- Every tool call with token name, client IP and parameters; session start/stop with duration
- Failed logins with reason (unknown / disabled / invalid admin token) — presented tokens are never logged
- Admin API actions ([example output](https://github.com/Tommi2Day/pg-mcp-server#logging)); `LOG_LEVEL` (`debug`/`info`/`warn`/`error`) — SQL text only at `debug`

**Operations**
- Docker image on Docker Hub, `docker-compose` with test database, persistent volumes for tokens and certs
- Helm chart: PVC for the token store, existing Secrets, ingress, HPA, TLS-aware health probes
- Only two runtime dependencies (MCP SDK, `pg`), no build step, ~100 unit tests, Dependabot updates

## Why this server?

Most PostgreSQL MCP servers are built for **one developer on one machine**: started via stdio with a single connection string, no authentication and no audit trail. This server targets the **shared, self-hosted** case — a team or several AI clients using one central instance:

| | Typical PostgreSQL MCP server | pg-mcp-server |
|---|---|---|
| Deployment | Local process per user (stdio) | Central service (Docker / Kubernetes) plus stdio |
| Authentication | None — whoever can start it has access | Bearer tokens, admin vs. client, revocable at runtime |
| Databases per instance | One connection string | One per token, managed centrally |
| Credential handling | DB password in every client config | DB password stays on the server; clients only get a revocable token |
| Read-only safety | Often SQL keyword checks or none | Enforced by PostgreSQL (`BEGIN READ ONLY`) |
| Audit | Usually none | Who ran which tool from which IP, failed logins, sessions |
| Transport security | Plain local process | HTTPS, mTLS, verified TLS to PostgreSQL |

Compared to the archived reference server [`@modelcontextprotocol/server-postgres`](https://github.com/modelcontextprotocol/servers-archived) (stdio only, a single read-only `query` tool), this server adds schema tools, a separate write tool, remote transport and everything above.

**When to choose something else:** if you need DBA features such as index tuning, `EXPLAIN` analysis or health checks, look at [Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp); for several database engines (MySQL, SQL Server, SQLite, …) behind one server, look at [DBHub](https://github.com/bytebase/dbhub). pg-mcp-server focuses on secure, audited, multi-user SQL access to PostgreSQL.

## Quick start

```bash
docker run -d --name pg-mcp-server \
  -p 3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e TRANSPORT=http \
  -e AUTH_TOKEN=$(openssl rand -hex 32) \
  -e STORE_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e PG_HOST=host.docker.internal \
  -e PG_DATABASE=mydb \
  -e PG_USER=user \
  -e PG_PASSWORD=password \
  -v pg-mcp-data:/data \
  -v pg-mcp-certs:/certs \
  tommi2day/pg-mcp-server:latest
```

- MCP endpoint: `http://<HOST>:3000/mcp` · Admin UI: `http://<HOST>:3000/admin` · Health: `/health`
- `pg-mcp-data` keeps the token store (`/data/tokens.json`), `pg-mcp-certs` keeps TLS certificates (`/certs`)
- The container runs as uid 1000; mounted volumes must be writable by that user
- HTTPS: set `TLS_ENABLED=true` — a self-signed certificate is generated in `/certs` if none is mounted

Connect a client (e.g. Claude Code):

```bash
claude mcp add --transport http postgresql http://localhost:3000/mcp \
  --header "Authorization: Bearer <TOKEN>"
```

## Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest release |
| `1.2.3` | Specific version |
| `1.2` | Latest patch of 1.2 |
| `1` | Latest minor of 1 |
| `sha-abc1234` | Specific commit |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3000` | HTTP(S) port |
| `AUTH_TOKEN` | – | Admin token for `/mcp` and `/admin/tokens` (empty = auth disabled) |
| `MCP_SERVER_NAME` | `pg-mcp-server` | Server name shown in MCP clients and the Admin UI title |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. SQL text of `query`/`execute` is only logged at `debug` |
| `STORE_ENCRYPTION_KEY` | – | Passphrase for AES-256-GCM encryption of stored connection passwords. Set before adding tokens with passwords. |
| `TOKENS_FILE` | `./tokens.json` | Path to the JSON file that stores tokens and their connection configs |
| `TLS_ENABLED` | `false` | `true` → HTTPS, `false` → HTTP |
| `TLS_CERT_FILE` | `/certs/tls.crt` | Server certificate (PEM) |
| `TLS_KEY_FILE` | `/certs/tls.key` | Server key (PEM) |
| `TLS_CA_FILE` | – | Client CA for mTLS (optional) |
| `TLS_SAN` | – | Additional SANs for self-signed cert, e.g. `DNS:myhost,IP:1.2.3.4` |
| `PG_HOST` | `localhost` | Default PostgreSQL host (used when a token has no custom connection) |
| `PG_PORT` | `5432` | Default PostgreSQL port |
| `PG_DATABASE` | `postgres` | Default database name |
| `PG_USER` | `postgres` | Default username |
| `PG_PASSWORD` | – | Default password |
| `PG_SSL` | `false` | Default SSL mode: `false` / `true` / `verify` |
| `PG_SSL_CA_FILE` | – | CA for PostgreSQL certificate (when `PG_SSL=verify`) |
| `PG_SSL_CERT_FILE` | – | Client certificate for PostgreSQL mTLS |
| `PG_SSL_KEY_FILE` | – | Client key for PostgreSQL mTLS |

More options (Kubernetes/Helm, Traefik, mTLS, token CLI): see the [full README](https://github.com/Tommi2Day/pg-mcp-server#readme).

## MCP tools

| Tool | Description |
|------|-------------|
| `test_connection` | Check connection and TLS status |
| `list_schemas` | List all schemas |
| `list_tables` | List tables in a schema |
| `describe_table` | Show columns, types and constraints |
| `query` | Execute a read-only SQL query (max 200 rows, wrapped in `BEGIN READ ONLY` / `COMMIT`) |
| `execute` | Execute INSERT / UPDATE / DELETE / DDL (wrapped in `BEGIN` / `COMMIT`) |

## Admin UI

Manage tokens and their database connections at `/admin`:

![Admin UI: token list](https://raw.githubusercontent.com/Tommi2Day/pg-mcp-server/main/docs/images/admin-tokens.png)

## Audit logging

All activity is written to stderr (`docker logs pg-mcp-server`): tool calls, session start/stop, rejected logins and admin actions. SQL text is only logged at `LOG_LEVEL=debug`.

![Log output at LOG_LEVEL=info](https://raw.githubusercontent.com/Tommi2Day/pg-mcp-server/main/docs/images/logs-info.png)

Details: [Logging](https://github.com/Tommi2Day/pg-mcp-server#logging) · License and issues: [GitHub](https://github.com/Tommi2Day/pg-mcp-server)
