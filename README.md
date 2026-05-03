# PostgreSQL MCP Server

Connects Claude to PostgreSQL via the Model Context Protocol (MCP).

![CI](https://github.com/tommi2day/pg-mcp-server/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/Tommi2Day/pg-mcp-server/graph/badge.svg?token=CYLM3NQPZK)](https://codecov.io/gh/Tommi2Day/pg-mcp-server)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/tommi2day/pg-mcp-server)
![Docker Pulls](https://img.shields.io/docker/pulls/tommi2day/pg-mcp-server)

## Overview

| Mode | Transport | When to use |
|------|-----------|-------------|
| Local (Node.js) | stdio | Development, no Docker |
| Docker / Remote | HTTP or HTTPS | Different host on the network |
| Kubernetes | HTTP or HTTPS | Production, Helm chart |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3000` | HTTP(S) port |
| `AUTH_TOKEN` | – | Admin token for `/mcp`, `/admin/tokens`, and `/info` (empty = auth disabled) |
| `MCP_SERVER_NAME` | `pg-mcp-server` | Server name shown in MCP clients and the Admin UI title |
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

---

## Docker Hub

The image is available on Docker Hub:

```bash
docker pull tommi2day/pg-mcp-server:latest
```

| Tag | Description |
|-----|-------------|
| `latest` | Latest build from `main` |
| `1.2.3` | Specific version |
| `1.2` | Latest patch of 1.2 |
| `sha-abc1234` | Specific commit |

### Quick start from Hub

```bash
docker run -d --name pg-mcp-server \
  -p 3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e TRANSPORT=http \
  -e AUTH_TOKEN=$(openssl rand -hex 32) \
  -e TOKENS_FILE=/data/tokens.json \
  -e PG_HOST=host.docker.internal \
  -e PG_DATABASE=mydb \
  -e PG_USER=user \
  -e PG_PASSWORD=password \
  -v pg-mcp-data:/data \
  tommi2day/pg-mcp-server:latest
```

### In docker-compose.yml

Use the Hub image instead of building locally:

```yaml
services:
  pg-mcp-server:
    image: tommi2day/pg-mcp-server:latest
    # build: .   ← remove or comment out
```

---

## 1 · Local (stdio)

```bash
npm install
node index.js
```

`claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "postgresql": {
      "command": "node",
      "args": ["/path/to/index.js"],
      "env": {
        "PG_HOST": "localhost",
        "PG_DATABASE": "mydb",
        "PG_USER": "user",
        "PG_PASSWORD": "password"
      }
    }
  }
}
```

---

## 2 · Docker

### Quick start with `run.sh`

`scripts/run.sh` builds and starts the container in one step:

```bash
# Optionally configure the PostgreSQL connection via .env in the project root
cp .env.example .env
# edit .env: set PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD, ...

./scripts/run.sh              # start as "pg-mcp-server"
./scripts/run.sh my-name      # start with a custom container name
```

`run.sh` reads PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD / PG_SSL from `.env` and auto-generates `AUTH_TOKEN` on first run (saved to `./auth_token`).

- Stops and removes any existing container with the same name
- Auto-generates `AUTH_TOKEN` on first run and saves it to `./auth_token`
- Reads `.env` from the project root if present

### Quick start (manual)

```bash
# Build image
docker build -t pg-mcp-server .

# Run against a local PostgreSQL
docker run -d --name pg-mcp-server \
  -p 3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e TRANSPORT=http \
  -e AUTH_TOKEN=$(openssl rand -hex 32) \
  -e TOKENS_FILE=/data/tokens.json \
  -e PG_HOST=host.docker.internal \
  -e PG_DATABASE=mydb \
  -e PG_USER=user \
  -e PG_PASSWORD=password \
  -v pg-mcp-data:/data \
  pg-mcp-server
```

### With docker-compose (including test database)

Copy the example env file, edit it, then start:

```bash
cp .env.example .env
# edit .env: set AUTH_TOKEN, PG_PASSWORD, etc.

docker compose up -d
docker compose logs -f pg-mcp-server
```

`docker compose` automatically reads `.env` from the project root. The `docker-compose.yml` includes a `postgres-test` container (port `5433`) that must be healthy before `pg-mcp-server` starts (`depends_on: condition: service_healthy`).

Key variables in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | _(empty)_ | Admin bearer token; leave empty to disable auth |
| `MCP_SERVER_NAME` | `pg-mcp-server` | Server name shown in MCP clients and the Admin UI |
| `STORE_ENCRYPTION_KEY` | _(empty)_ | Passphrase for AES-256-GCM encryption of stored connection passwords |
| `MCP_PORT` | `3000` | Host port for the MCP server |
| `PG_HOST` | `postgres-test` | PostgreSQL host (use `host.docker.internal` for a local DB outside Docker) |
| `PG_DATABASE` | `testdb` | Database name |
| `PG_USER` | `postgres` | Database user |
| `PG_PASSWORD` | `postgres` | Database password |
| `PG_SSL` | `false` | `false` / `true` / `verify` |
| `TLS_ENABLED` | `false` | `true` to enable HTTPS |

### Enable TLS (optional)

```yaml
environment:
  TLS_ENABLED: "true"
  TLS_SAN: "DNS:my-host.local,IP:192.168.1.10"
volumes:
  - ./certs:/certs   # mount real certs; leave empty → self-signed is generated
```

On startup:
- `/certs` contains a certificate → it is used (permissions are adjusted automatically)
- `/certs` is empty → a self-signed certificate is generated automatically

Once running, open `http://localhost:3000/admin` to manage tokens via the web UI.

### Traefik reverse proxy (optional)

Route traffic through Traefik with automatic HTTP → HTTPS redirect and Let's Encrypt TLS.  
TLS terminates at Traefik — keep `TLS_ENABLED=false` inside the container.

Both variants require the `traefik-public` external network (created by your Traefik stack).  
Add it to the `pg-mcp-server` service networks list:

```yaml
networks:
  - mcp-net
  - traefik-public
```

And declare it in the top-level `networks:` section:

```yaml
networks:
  mcp-net:
    driver: bridge
  traefik-public:
    external: true
```

#### Host-based routing

Dedicated domain for the MCP server (e.g. `pg-mcp.example.com`):

```yaml
labels:
  - "traefik.enable=true"
  # HTTP → HTTPS redirect
  - "traefik.http.routers.pg-mcp-http.rule=Host(`pg-mcp.example.com`)"
  - "traefik.http.routers.pg-mcp-http.entrypoints=web"
  - "traefik.http.routers.pg-mcp-http.middlewares=pg-mcp-https-redirect"
  - "traefik.http.middlewares.pg-mcp-https-redirect.redirectscheme.scheme=https"
  - "traefik.http.middlewares.pg-mcp-https-redirect.redirectscheme.permanent=true"
  # HTTPS router
  - "traefik.http.routers.pg-mcp.rule=Host(`pg-mcp.example.com`)"
  - "traefik.http.routers.pg-mcp.entrypoints=websecure"
  - "traefik.http.routers.pg-mcp.tls=true"
  - "traefik.http.routers.pg-mcp.tls.certresolver=letsencrypt"
  - "traefik.http.services.pg-mcp.loadbalancer.server.port=3000"
  - "traefik.docker.network=traefik-public"
```

MCP URL: `https://pg-mcp.example.com/mcp`

#### Path-based routing

Sub-path on a shared domain (e.g. `https://proxy.example.com/pg-mcp`).  
Traefik strips the `/pg-mcp` prefix before forwarding, so the container still receives requests at `/mcp`, `/admin/tokens`, etc. unchanged.

```yaml
labels:
  - "traefik.enable=true"
  # HTTP → HTTPS redirect
  - "traefik.http.routers.pg-mcp-http.rule=PathPrefix(`/pg-mcp`)"
  - "traefik.http.routers.pg-mcp-http.entrypoints=web"
  - "traefik.http.routers.pg-mcp-http.middlewares=pg-mcp-https-redirect"
  - "traefik.http.middlewares.pg-mcp-https-redirect.redirectscheme.scheme=https"
  - "traefik.http.middlewares.pg-mcp-https-redirect.redirectscheme.permanent=true"
  # HTTPS router — strip prefix, then forward to container
  - "traefik.http.routers.pg-mcp.rule=PathPrefix(`/pg-mcp`)"
  - "traefik.http.routers.pg-mcp.entrypoints=websecure"
  - "traefik.http.routers.pg-mcp.tls=true"
  - "traefik.http.routers.pg-mcp.tls.certresolver=letsencrypt"
  - "traefik.http.routers.pg-mcp.middlewares=pg-mcp-strip"
  - "traefik.http.middlewares.pg-mcp-strip.stripprefix.prefixes=/pg-mcp"
  - "traefik.http.services.pg-mcp.loadbalancer.server.port=3000"
  - "traefik.docker.network=traefik-public"
```

MCP URL: `https://proxy.example.com/pg-mcp/mcp`

For `run.sh` / `docker run`, translate each label to a `--label` flag.

### Connect Claude Desktop / `.mcp.json`

```json
{
  "mcpServers": {
    "postgresql": {
      "type": "http",
      "url": "http://<HOST>:3000/mcp",
      "headers": {
        "Authorization": "Bearer <AUTH_TOKEN>"
      }
    }
  }
}
```

Replace `http://` with `https://` for HTTPS.

### Claude Desktop (`claude_desktop_config.json`) — HTTP/Remote

> [!WARNING]
> **Claude Desktop only supports HTTPS for non-local (remote) MCP servers.**
> If your server runs on plain HTTP and is not on `localhost`, Claude Desktop will refuse the connection.
> Use one of the options below:
>
> **Option A — Preferred:** Put the server behind a reverse proxy (Traefik, nginx, Caddy) with a valid TLS certificate and use `https://` in the URL.
>
> **Option B — Quick workaround:** Use [`mcp-remote`](https://github.com/geelen/mcp-remote) as a local stdio bridge. It runs on your machine and forwards requests to the HTTP server, so Claude Desktop treats it like a stdio tool.

```json
{
  "mcpServers": {
    "postgresql": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://192.168.1.100:3000/mcp",
        "--allow-http",
        "--header", "Authorization:Bearer <AUTH_TOKEN>"
      ]
    }
  }
}
```

### Verify the MCP endpoint

**Health check:**
```bash
curl http://localhost:3000/health
```

**MCP initialize handshake** (checks that the server responds to MCP requests):
```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <AUTH_TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

**Interactive browser UI** via [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
```bash
# Local server — direct HTTP
npx @modelcontextprotocol/inspector http://localhost:3000/mcp

# Remote HTTP server — via mcp-remote bridge
npx @modelcontextprotocol/inspector \
  npx mcp-remote http://192.168.1.100:3000/mcp \
  --allow-http \
  --header "Authorization:Bearer <AUTH_TOKEN>"
```

The inspector opens a browser UI where you can list tools, call them individually, and inspect responses.

---

## 3 · Kubernetes with Helm

### Prerequisites

- `kubectl` configured
- `helm` v3 installed
- Image accessible in a registry

### Quick start (HTTP, no TLS)

```bash
helm install pg-mcp ./helm/pg-mcp-server \
  --namespace mcp --create-namespace \
  --set image.repository=tommi2day/pg-mcp-server \
  --set postgresql.host=my-db-host \
  --set postgresql.database=mydb \
  --set postgresql.user=user \
  --set postgresql.password=secret \
  --set auth.token=$(openssl rand -hex 32)
```

### With HTTPS

```bash
# Create TLS secret
kubectl create secret tls pg-mcp-tls \
  --cert=certs/tls.crt --key=certs/tls.key -n mcp

# Create auth secret
kubectl create secret generic my-auth-secret \
  --from-literal=token=$(openssl rand -hex 32) -n mcp

# PostgreSQL CA (only for PG_SSL=verify)
kubectl create secret generic pg-ca-cert \
  --from-file=ca.crt=certs/pg-ca.crt -n mcp

helm install pg-mcp ./helm/pg-mcp-server \
  --namespace mcp --create-namespace \
  --set server.tlsEnabled=true \
  --set tls.existingSecret=pg-mcp-tls \
  --set auth.existingSecret=my-auth-secret \
  --set postgresql.ssl=verify \
  --set tls.pgCaSecret=pg-ca-cert \
  --set image.repository=tommi2day/pg-mcp-server \
  --set postgresql.host=my-db-host \
  --set postgresql.database=mydb \
  --set postgresql.user=user \
  --set postgresql.existingSecret=pg-credentials
```

### Production values.yaml

```yaml
image:
  repository: tommi2day/pg-mcp-server
  tag: "latest"

replicaCount: 2

persistence:
  enabled: true
  size: 50Mi
  storageClass: "standard"

auth:
  existingSecret: "my-auth-secret"

postgresql:
  host: "rds.example.com"
  database: "prod_db"
  user: "prod_user"
  ssl: "verify"
  existingSecret: "pg-credentials"

server:
  tlsEnabled: true

tls:
  existingSecret: "pg-mcp-tls"
  pgCaSecret: "pg-ca-cert"

service:
  type: LoadBalancer

ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: pg-mcp.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: pg-mcp-ingress-tls
      hosts:
        - pg-mcp.example.com

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
```

### Upgrade / Uninstall

```bash
helm upgrade pg-mcp ./helm/pg-mcp-server -n mcp -f my-values.yaml
helm uninstall pg-mcp -n mcp
```

---

## Authentication

`AUTH_TOKEN` (env var) is the **admin token** — it grants access to `/mcp` and the token management API.
Additional **file tokens** can be created via the admin UI or API; they only have access to `/mcp`.
Token values are stored as SHA-256 hashes in a local JSON file (`TOKENS_FILE`); plaintext is shown only once at creation and never stored.

Each file token can optionally have its own PostgreSQL connection. When a token has no custom connection, it uses the server's default connection (`PG_HOST` / `PG_DATABASE` / … env vars).

No `AUTH_TOKEN` set → auth is completely disabled (local/dev only). The admin UI still works but does not require a token.

### Admin UI

Open `http://<HOST>:3000/admin` in a browser. The web interface lets you manage tokens without using the command line or curl.

- **Login**: enter the server URL and the `AUTH_TOKEN` value. Leave the token field empty if auth is disabled.
- **Token list**: see all tokens with status (active/inactive), connection info, and last-used timestamp.
- **Create token**: enter a name and optionally configure a custom PostgreSQL connection. The generated token value is shown once — copy it before closing.
- **Edit token**: rename a token, toggle its active state, or update its database connection.
- **Delete token**: permanently removes the token record and immediately revokes access.

The session is stored in `sessionStorage` (cleared when the browser tab is closed).

### Token store

Tokens are persisted in a JSON file (default `./tokens.json`, configurable via `TOKENS_FILE`).  
**Mount a volume** at the file's directory so tokens survive container restarts — see the Docker and Helm sections above.

#### Password encryption

Set `STORE_ENCRYPTION_KEY` to a passphrase to enable AES-256-GCM encryption of `connection.password` values at rest. Passwords are encrypted on save and decrypted transparently on load. On startup the server migrates any plaintext passwords it finds in the file — no manual step required.

```bash
export STORE_ENCRYPTION_KEY="my-secret-passphrase"
```

Without this variable the passwords are stored as plaintext (acceptable for local/dev use). Changing the key requires re-saving every token (plaintext migration runs automatically on startup only when the key is set).

### Manage tokens with `admincli.sh`

`admincli.sh` reads `AUTH_TOKEN` and `MCP_URL` from environment variables or from a `scripts/.env` file:

```bash
# Option A – environment variables
export AUTH_TOKEN=<admin-token>
export MCP_URL=http://localhost:3000   # optional, default

# Option B – scripts/.env file
cat > scripts/.env <<EOF
AUTH_TOKEN=<admin-token>
MCP_URL=http://localhost:3000
EOF
```

> When using `run.sh`, the generated token is stored in `./auth_token`:
> ```bash
> export AUTH_TOKEN=$(cat auth_token)
> ```

```bash
# Server info
./scripts/admincli.sh health                        # server health status + TLS flag (no auth required)
./scripts/admincli.sh info                          # server name, version + default DB connection (AUTH_TOKEN required when set)

# Token management
./scripts/admincli.sh list-tokens                   # list all tokens (CONN column shows per-token connection)
./scripts/admincli.sh show-token <id>               # full details for one token, including connection config
./scripts/admincli.sh add-token "claude-desktop"    # create new token (plaintext shown once)
./scripts/admincli.sh delete-token <id>             # permanently delete token
./scripts/admincli.sh disable-token <id>            # temporarily block
./scripts/admincli.sh enable-token  <id>            # re-enable
./scripts/admincli.sh rename-token  <id> <new-name> # rename

# Per-token database connection — pass flags or env vars (flags take precedence)
./scripts/admincli.sh add-token "mydb-client" \
  --host db.example.com --database mydb --user u --password p --ssl false

# env-var form still works:
PG_HOST=db.example.com PG_DATABASE=mydb PG_USER=u PG_PASSWORD=p \
  ./scripts/admincli.sh add-token "mydb-client"

./scripts/admincli.sh set-conn <id> '{"host":"db.example.com","port":5432,"database":"mydb","user":"u","password":"p"}'
./scripts/admincli.sh clear-conn <id>               # reset to default admin connection
```

`add-token` connection flags: `--host`, `--port`, `--database`, `--user`, `--password`, `--ssl`.  
Flags take precedence over the corresponding `PG_*` env vars. Omit all connection arguments to use the server's default admin connection.

### Validate a token with `test_token.sh`

Connects to the server using the given token and lists tables — useful to confirm a newly created token works:

```bash
./scripts/test_token.sh <token>              # schema: public (default)
./scripts/test_token.sh <token> myschema     # specific schema
```

Reads `MCP_URL` from environment or `scripts/.env`. Exits with a clear error message on failure (invalid token, server unreachable, MCP tool error, etc.).

The script sends an `X-Real-IP` header so the server logs the real client IP. The value is taken from `X_REAL_IP` env var if set, otherwise auto-detected from the first local interface (`hostname -I`).

### Manage tokens with curl

```bash
# List tokens (includes connection info; token_hash is never returned)
curl http://localhost:3000/admin/tokens \
  -H "Authorization: Bearer $AUTH_TOKEN"

# Create token (default connection)
curl -X POST http://localhost:3000/admin/tokens \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "claude-desktop"}'

# Create token with a custom DB connection
curl -X POST http://localhost:3000/admin/tokens \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "mydb-client",
    "connection": {
      "host": "db.example.com",
      "port": 5432,
      "database": "mydb",
      "user": "myuser",
      "password": "secret",
      "ssl": "false"
    }
  }'

# Set or update the connection on an existing token
curl -X PATCH http://localhost:3000/admin/tokens/<id> \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"connection": {"host": "db.example.com", "database": "mydb", "user": "u", "password": "p"}}'

# Clear per-token connection (fall back to default admin connection)
curl -X PATCH http://localhost:3000/admin/tokens/<id> \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"connection": null}'

# Rename / re-enable token
curl -X PATCH http://localhost:3000/admin/tokens/<id> \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-name", "active": true}'

# Delete token (permanently removed)
curl -X DELETE http://localhost:3000/admin/tokens/<id> \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

### Logging

All log lines go to **stderr** and are visible in `docker logs <name>`. Each line carries an ISO 8601 timestamp and a bracketed prefix:

```
[2026-03-28T19:32:51.654Z] [MCP]   token="claude-desktop" action="list_tables" ip="192.168.1.10" params={"schema":"public"}
[2026-03-28T19:32:51.859Z] [MCP]   token="claude-desktop" action="query" ip="192.168.1.10" error="column \"x\" does not exist"
[2026-03-28T19:32:51.859Z] [ADMIN] token="admin"          action="POST /admin/tokens" ip="192.168.1.10"
[2026-03-28T19:32:52.001Z] [ADMIN] token="admin"          action="GET /admin/tokens" ip="192.168.1.10" error="ENOENT: ..."
[2026-03-28T19:32:52.100Z] [DB]    Pool error: Connection terminated unexpectedly
[2026-03-28T19:32:52.200Z] [HTTP]  Unhandled error for POST /mcp: socket hang up
[2026-03-28T19:33:00.000Z] [FATAL] Unhandled rejection: getaddrinfo ENOTFOUND db.example.com
```

| Prefix | When |
|--------|------|
| `[MCP]` | MCP tool call (success and error). Token name is `"admin"` for the env token, `"anonymous"` when auth is disabled, or the file token's name. `params` is omitted for tools with no arguments. |
| `[ADMIN]` | Admin API request. Always `token="admin"`. Errors include `error="..."`. |
| `[DB]` | Idle pool error (e.g. dropped connection) from the default or a per-token pool. |
| `[HTTP]` | Unhandled error in the HTTP request handler, or failure to read `admin.html`. |
| `[FATAL]` | Unhandled promise rejection or uncaught exception — the process exits after logging. |

The client IP is resolved in order: `x-real-ip` header → first entry of `x-forwarded-for` → TCP socket address. When running Docker without a reverse proxy, the socket address is the Docker bridge IP — deploy behind nginx or Traefik to log the real client IP.

### Token file format

The token store is a plain JSON file. The server reads and writes it automatically — do not edit it while the server is running.

```json
{
  "tokens": [
    {
      "id": 1,
      "name": "claude-desktop",
      "token_hash": "<sha256-hex>",
      "created_at": "2026-04-03T10:00:00.000Z",
      "last_used_at": "2026-04-03T12:34:56.789Z",
      "active": true,
      "connection": null
    },
    {
      "id": 2,
      "name": "mydb-client",
      "token_hash": "<sha256-hex>",
      "created_at": "2026-04-03T10:05:00.000Z",
      "last_used_at": null,
      "active": true,
      "connection": {
        "host": "db.example.com",
        "port": 5432,
        "database": "mydb",
        "user": "myuser",
        "password": "enc:v1:<iv-hex>:<tag-hex>:<ciphertext-hex>",
        "ssl": "false"
      }
    }
  ],
  "next_id": 3
}
```

`connection: null` means the token uses the server's default PostgreSQL connection. The `token_hash` field is a SHA-256 hex digest — the plaintext token is never stored. When `STORE_ENCRYPTION_KEY` is set, `connection.password` is stored as `enc:v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM); otherwise it is stored in plaintext.

## Automated Updates

Dependabot is configured to check for updates weekly for:
- **npm** dependencies (grouped into `production` and `dev`)
- **Docker** base images
- **GitHub Actions**

The [Dependabot Automerge](.github/workflows/dependabot-automerge.yml) workflow automatically enables auto-merge for Dependabot PRs.

---

## Development

```bash
# Install dependencies
npm install

# Run tests
./scripts/test.sh                        # all tests
./scripts/test.sh tests/lib.test.js      # single file

# Coverage report
./scripts/coverage.sh                    # report written to ./coverage/
./scripts/coverage.sh --open             # open HTML report in browser

# Linting
./scripts/lint.sh                        # check all files
./scripts/lint.sh --fix                  # auto-fix issues
```

All scripts require only Docker — no local Node.js needed.

---

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `test_connection` | Check connection and TLS status |
| `list_schemas` | List all schemas |
| `list_tables` | List tables in a schema |
| `describe_table` | Show columns, types and constraints |
| `query` | Execute a read-only SQL query (max 200 rows, wrapped in `BEGIN READ ONLY` / `COMMIT`) |
| `execute` | Execute INSERT / UPDATE / DELETE / DDL (wrapped in `BEGIN` / `COMMIT`) |

---

## Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `POST /mcp` | Admin or file token | MCP Streamable-HTTP (uses token's connection if set) |
| `GET /info` | Admin token (when `AUTH_TOKEN` is set) | Server name, version + default DB connection config (no password) |
| `GET /health` | none | Health check (`{"status":"ok","tls":<bool>}`) |
| `GET /admin` | none | Web-based token administration UI |
| `GET /admin/tokens` | Admin token only | List tokens with connection info (no hashes) |
| `POST /admin/tokens` | Admin token only | Create token; optional `connection` object |
| `PATCH /admin/tokens/:id` | Admin token only | Update `name`, `active`, and/or `connection` |
| `DELETE /admin/tokens/:id` | Admin token only | Permanently delete token |

### `GET /info`

Returns the server name, version, and the default PostgreSQL connection configuration (host, port, database, user, ssl mode). The password is never included.

Requires the admin token when `AUTH_TOKEN` is set (same as `/admin/tokens`).

```json
{
  "name": "pg-mcp-server",
  "version": "0.0.13",
  "db": {
    "host": "localhost",
    "port": 5432,
    "database": "postgres",
    "user": "postgres",
    "ssl": "false"
  }
}
```

A full OpenAPI 3.1 specification is available in [`openapi.json`](openapi.json).

---

## Release

The release workflow (`.github/workflows/release.yml`) runs lint, tests, builds and pushes the Docker image, and creates a GitHub Release with auto-generated notes.

### Option 1 — Push a git tag

Use `npm version` to bump all version files together, then push the tag:

```bash
npm version 1.2.3   # bumps package.json, openapi.json and Chart.yaml, commits, creates git tag
git push origin main 1.2.3
```

The `version` lifecycle script keeps `openapi.json` and `helm/pg-mcp-server/Chart.yaml` in sync automatically. The tag must match `[0-9]+.[0-9]+.[0-9]+` (e.g. `1.2.3`, no `v` prefix).

### Option 2 — Manual dispatch (no local git required)

Go to **Actions → Release → Run workflow**, enter a version number (e.g. `1.2.3`), and click **Run workflow**.

The workflow will:
1. **Bump** `package.json`, `openapi.json` and `helm/pg-mcp-server/Chart.yaml` to the entered version, commit and push to `main`
2. Run lint and tests
3. Build and push the Docker image (`tommi2day/pg-mcp-server:1.2.3`, `:1.2`, `:1`, `:latest`, `:sha-<short>`)
4. **Create and push the git tag** automatically
5. Publish a GitHub Release with auto-generated notes

### Docker image tags per release

| Tag | Example |
|-----|---------|
| Full version | `1.2.3` |
| Major.minor | `1.2` |
| Major | `1` |
| Latest | `latest` |
| Commit SHA | `sha-abc1234` |
