# PostgreSQL MCP Server

Connects Claude to PostgreSQL via the Model Context Protocol (MCP).

![CI](https://github.com/tommi2day/pg-mcp-server/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/Tommi2Day/pg-mcp-server/graph/badge.svg?token=CYLM3NQPZK)](https://codecov.io/gh/Tommi2Day/pg-mcp-server)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/tommi2day/pg-mcp-server)

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
| `AUTH_TOKEN` | – | Admin token for `/mcp` and `/admin/tokens` (empty = auth disabled) |
| `TLS_ENABLED` | `false` | `true` → HTTPS, `false` → HTTP |
| `TLS_CERT_FILE` | `/certs/tls.crt` | Server certificate (PEM) |
| `TLS_KEY_FILE` | `/certs/tls.key` | Server key (PEM) |
| `TLS_CA_FILE` | – | Client CA for mTLS (optional) |
| `TLS_SAN` | – | Additional SANs for self-signed cert, e.g. `DNS:myhost,IP:1.2.3.4` |
| `PG_HOST` | `localhost` | PostgreSQL host |
| `PG_PORT` | `5432` | PostgreSQL port |
| `PG_DATABASE` | `postgres` | Database name |
| `PG_USER` | `postgres` | Username |
| `PG_PASSWORD` | – | Password |
| `PG_SSL` | `false` | `false` / `true` / `verify` |
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
  -e PG_HOST=host.docker.internal \
  -e PG_DATABASE=mydb \
  -e PG_USER=user \
  -e PG_PASSWORD=password \
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
# Optionally set PostgreSQL connection via .env in the project root
cp .env.example .env
# edit .env: set PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD, ...

./scripts/run.sh              # start as "pg-mcp-server"
./scripts/run.sh my-name      # start with a custom container name
```

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
  -e PG_HOST=host.docker.internal \
  -e PG_DATABASE=mydb \
  -e PG_USER=user \
  -e PG_PASSWORD=password \
  pg-mcp-server
```

### With docker-compose (including test database)

Edit `docker-compose.yml` and start:

```bash
docker compose up -d
docker compose logs -f pg-mcp-server
```

The `docker-compose.yml` includes a `postgres-test` container (port `5433`) that must be healthy before `pg-mcp-server` starts (`depends_on: condition: service_healthy`).

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
Additional **DB tokens** can be created via the API; they only have access to `/mcp`.
Token values are stored as SHA-256 hashes (plaintext is never stored in the database).

No `AUTH_TOKEN` set → auth is completely disabled (local/dev only).

### Manage tokens with `token.sh`

`token.sh` reads `AUTH_TOKEN` and `MCP_URL` from environment variables or from a `scripts/.env` file:

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
./scripts/token.sh list                     # list all tokens
./scripts/token.sh add "claude-desktop"     # create new token (plaintext shown once)
./scripts/token.sh delete <id>              # deactivate token
./scripts/token.sh disable <id>             # temporarily block
./scripts/token.sh enable  <id>             # re-enable
./scripts/token.sh rename  <id> <new-name>  # rename
```

### Validate a token with `test_token.sh`

Connects to the server using the given token and lists tables — useful to confirm a newly created token works:

```bash
./scripts/test_token.sh <token>              # schema: public (default)
./scripts/test_token.sh <token> myschema     # specific schema
```

Reads `MCP_URL` from environment or `scripts/.env`. Exits with a clear error message on failure (invalid token, server unreachable, MCP tool error, etc.).

### Manage tokens with curl

```bash
# Create token
curl -X POST http://localhost:3000/admin/tokens \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "claude-desktop"}'

# List tokens
curl http://localhost:3000/admin/tokens \
  -H "Authorization: Bearer $AUTH_TOKEN"

# Deactivate token
curl -X DELETE http://localhost:3000/admin/tokens/<id> \
  -H "Authorization: Bearer $AUTH_TOKEN"

# Rename / re-enable token
curl -X PATCH http://localhost:3000/admin/tokens/<id> \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-name", "active": true}'
```

### Connection logging

Every authenticated request is logged to stderr with a timestamp, the token name, and the action:

```
[2026-03-28T19:32:51.654Z] [MCP]   token="claude-desktop" action="list_tables"
[2026-03-28T19:32:51.859Z] [ADMIN] token="admin"          action="POST /admin/tokens" ip="192.168.1.10"
```

- `[MCP]` — MCP tool calls; token name is `"admin"` for the env token, `"anonymous"` when auth is disabled, or the DB token's name
- `[ADMIN]` — admin API requests; always `token="admin"`

### Database schema

The table is created automatically on startup:

```sql
CREATE TABLE IF NOT EXISTS mcp_auth_tokens (
  id           SERIAL PRIMARY KEY,
  name         TEXT        NOT NULL,
  token_hash   TEXT        NOT NULL UNIQUE,  -- SHA-256, plaintext never stored
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  active       BOOLEAN     NOT NULL DEFAULT true
);
```

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
| `query` | Execute SELECT (max 200 rows) |
| `execute` | Execute INSERT / UPDATE / DELETE / DDL |

---

## Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `POST /mcp` | Admin or DB token | MCP Streamable-HTTP |
| `GET /health` | none | Health check (`{"status":"ok","tls":<bool>}`) |
| `GET /admin/tokens` | Admin token only | List tokens |
| `POST /admin/tokens` | Admin token only | Create token |
| `PATCH /admin/tokens/:id` | Admin token only | Rename / enable / disable token |
| `DELETE /admin/tokens/:id` | Admin token only | Deactivate token |

---

## Release

The release workflow (`.github/workflows/release.yml`) runs lint, tests, builds and pushes the Docker image, and creates a GitHub Release with auto-generated notes.

### Option 1 — Push a git tag

```bash
git tag 1.2.3
git push origin 1.2.3
```

The tag must match `[0-9]+.[0-9]+.[0-9]+` (e.g. `1.2.3`, no `v` prefix).

### Option 2 — Manual dispatch (no local git required)

Go to **Actions → Release → Run workflow**, enter a version number (e.g. `1.2.3`), and click **Run workflow**.

The workflow will:
1. Run lint and tests
2. Build and push the Docker image (`tommi2day/pg-mcp-server:1.2.3`, `:1.2`, `:1`, `:latest`, `:sha-<short>`)
3. **Create and push the git tag** automatically
4. Publish a GitHub Release with auto-generated notes

### Docker image tags per release

| Tag | Example |
|-----|---------|
| Full version | `1.2.3` |
| Major.minor | `1.2` |
| Major | `1` |
| Latest | `latest` |
| Commit SHA | `sha-abc1234` |
