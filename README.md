# PostgreSQL MCP Server

Verbindet Claude mit PostgreSQL über das Model Context Protocol (MCP).

![CI](https://github.com/tommi2day/pg-mcp-server/actions/workflows/main.yml/badge.svg)
[![codecov](https://codecov.io/gh/Tommi2Day/pg-mcp-server/graph/badge.svg?token=CYLM3NQPZK)](https://codecov.io/gh/Tommi2Day/pg-mcp-server)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/tommi2day/pg-mcp-server)
## Übersicht

| Modus | Transport | Wann? |
|-------|-----------|-------|
| Lokal (Node.js) | stdio | Entwicklung, kein Docker |
| Docker / Remote | HTTP oder HTTPS | Anderer Host im Netz |
| Kubernetes | HTTP oder HTTPS | Produktion, Helm Chart |

---

## Umgebungsvariablen

| Variable | Default | Beschreibung |
|----------|---------|-------------|
| `TRANSPORT` | `stdio` | `stdio` oder `http` |
| `PORT` | `3000` | HTTP(S) Port |
| `AUTH_TOKEN` | – | Admin-Token für `/mcp` und `/admin/tokens` (leer = Auth deaktiviert) |
| `TLS_ENABLED` | `false` | `true` → HTTPS, `false` → HTTP |
| `TLS_CERT_FILE` | `/certs/tls.crt` | Server-Zertifikat (PEM) |
| `TLS_KEY_FILE` | `/certs/tls.key` | Server-Schlüssel (PEM) |
| `TLS_CA_FILE` | – | Client-CA für mTLS (optional) |
| `TLS_SAN` | – | Zusätzliche SANs für self-signed cert, z.B. `DNS:myhost,IP:1.2.3.4` |
| `PG_HOST` | `localhost` | PostgreSQL Host |
| `PG_PORT` | `5432` | PostgreSQL Port |
| `PG_DATABASE` | `postgres` | Datenbankname |
| `PG_USER` | `postgres` | Benutzername |
| `PG_PASSWORD` | – | Passwort |
| `PG_SSL` | `false` | `false` / `true` / `verify` |
| `PG_SSL_CA_FILE` | – | CA für PostgreSQL-Zertifikat (bei `PG_SSL=verify`) |
| `PG_SSL_CERT_FILE` | – | Client-Zertifikat für PostgreSQL mTLS |
| `PG_SSL_KEY_FILE` | – | Client-Schlüssel für PostgreSQL mTLS |

---

## Docker Hub

Das Image ist auf Docker Hub verfügbar:

```bash
docker pull tommi2day/pg-mcp-server:latest
```

| Tag | Beschreibung |
|-----|-------------|
| `latest` | Letzter Stand von `main` |
| `1.2.3` | Spezifische Version |
| `1.2` | Neueste Patch-Version von 1.2 |
| `sha-abc1234` | Spezifischer Commit |

### Direktstart vom Hub

```bash
docker run -d --name pg-mcp-server \
  -p 3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e TRANSPORT=http \
  -e AUTH_TOKEN=$(openssl rand -hex 32) \
  -e PG_HOST=host.docker.internal \
  -e PG_DATABASE=meine_db \
  -e PG_USER=user \
  -e PG_PASSWORD=passwort \
  tommi2day/pg-mcp-server:latest
```

### In docker-compose.yml

Statt `build: .` das Hub-Image verwenden:

```yaml
services:
  pg-mcp-server:
    image: tommi2day/pg-mcp-server:latest
    # build: .   ← entfernen oder auskommentieren
```

---

## 1 · Lokal (stdio)

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
      "args": ["/pfad/zu/index.js"],
      "env": {
        "PG_HOST": "localhost",
        "PG_DATABASE": "meine_db",
        "PG_USER": "user",
        "PG_PASSWORD": "passwort"
      }
    }
  }
}
```

---

## 2 · Docker

### Schnellstart

```bash
# Image bauen
docker build -t pg-mcp-server .

# Starten (gegen lokalen PostgreSQL)
docker run -d --name pg-mcp-server \
  -p 3000:3000 \
  --add-host=host.docker.internal:host-gateway \
  -e TRANSPORT=http \
  -e AUTH_TOKEN=$(openssl rand -hex 32) \
  -e PG_HOST=host.docker.internal \
  -e PG_DATABASE=meine_db \
  -e PG_USER=user \
  -e PG_PASSWORD=passwort \
  pg-mcp-server
```

### Mit docker-compose (inkl. Test-Datenbank)

`docker-compose.yml` anpassen und starten:

```bash
docker compose up -d
docker compose logs -f pg-mcp-server
```

Die `docker-compose.yml` enthält einen `postgres-test` Container (Port `5433`) der automatisch bereit sein muss bevor `pg-mcp-server` startet (`depends_on: condition: service_healthy`).

### TLS aktivieren (optional)

```yaml
environment:
  TLS_ENABLED: "true"
  TLS_SAN: "DNS:mein-host.local,IP:192.168.1.10"
volumes:
  - ./certs:/certs   # echte Certs mounten; leer lassen → self-signed wird generiert
```

Beim Start:
- `/certs` mit Zertifikat → wird verwendet (Rechte werden automatisch angepasst)
- `/certs` leer → self-signed Zertifikat wird automatisch generiert

### Claude Desktop / `.mcp.json` verbinden

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

Für HTTPS `http://` durch `https://` ersetzen.

---

## 3 · Kubernetes mit Helm

### Voraussetzungen

- `kubectl` konfiguriert
- `helm` v3 installiert
- Image in einer Registry erreichbar

### Schnellstart (HTTP, kein TLS)

```bash
helm install pg-mcp ./helm/pg-mcp-server \
  --namespace mcp --create-namespace \
  --set image.repository=tommi2day/pg-mcp-server \
  --set postgresql.host=mein-db-host \
  --set postgresql.database=meine_db \
  --set postgresql.user=user \
  --set postgresql.password=geheim \
  --set auth.token=$(openssl rand -hex 32)
```

### Mit HTTPS

```bash
# TLS Secret erstellen
kubectl create secret tls pg-mcp-tls \
  --cert=certs/tls.crt --key=certs/tls.key -n mcp

# Auth-Secret erstellen
kubectl create secret generic my-auth-secret \
  --from-literal=token=$(openssl rand -hex 32) -n mcp

# PostgreSQL CA (nur bei PG_SSL=verify)
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
  --set postgresql.host=mein-db-host \
  --set postgresql.database=meine_db \
  --set postgresql.user=user \
  --set postgresql.existingSecret=pg-credentials
```

### Produktions-values.yaml

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

### Upgrade / Deinstallation

```bash
helm upgrade pg-mcp ./helm/pg-mcp-server -n mcp -f my-values.yaml
helm uninstall pg-mcp -n mcp
```

---

## Authentifizierung

`AUTH_TOKEN` (Env-Var) ist das **Admin-Token** — es hat Zugriff auf `/mcp` und die Token-Verwaltungs-API.
Zusätzlich können beliebig viele **DB-Token** über die API angelegt werden, die nur `/mcp` nutzen dürfen.
Token-Werte werden als SHA-256-Hash gespeichert (Klartext nie in der Datenbank).

Kein `AUTH_TOKEN` gesetzt → Auth komplett deaktiviert (nur lokal/dev).

### Token verwalten mit `token.sh`

```bash
export AUTH_TOKEN=<admin-token>
export MCP_URL=http://localhost:3000   # optional, default

./token.sh list                        # alle Token anzeigen
./token.sh add "claude-desktop"        # neues Token erstellen (Klartext einmalig ausgegeben)
./token.sh delete <id>                 # Token deaktivieren
./token.sh disable <id>                # temporär sperren
./token.sh enable  <id>                # reaktivieren
./token.sh rename  <id> <neuer-name>   # umbenennen
```

### Token verwalten mit curl

```bash
# Token anlegen
curl -X POST http://localhost:3000/admin/tokens \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "claude-desktop"}'

# Token auflisten
curl http://localhost:3000/admin/tokens \
  -H "Authorization: Bearer $AUTH_TOKEN"

# Token deaktivieren
curl -X DELETE http://localhost:3000/admin/tokens/<id> \
  -H "Authorization: Bearer $AUTH_TOKEN"

# Token umbenennen / reaktivieren
curl -X PATCH http://localhost:3000/admin/tokens/<id> \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "neuer-name", "active": true}'
```

### Datenbankschema

Die Tabelle wird beim Start automatisch angelegt:

```sql
CREATE TABLE IF NOT EXISTS mcp_auth_tokens (
  id           SERIAL PRIMARY KEY,
  name         TEXT        NOT NULL,
  token_hash   TEXT        NOT NULL UNIQUE,  -- SHA-256, Klartext nie gespeichert
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  active       BOOLEAN     NOT NULL DEFAULT true
);
```

---

## Entwicklung

```bash
# Dependencies installieren
npm install

# Tests ausführen
./test.sh                        # alle Tests
./test.sh tests/lib.test.js      # einzelne Datei

# Linting
./lint.sh                        # alle Dateien prüfen
./lint.sh --fix                  # Fehler automatisch beheben
```

Beide Scripts benötigen nur Docker — kein lokales Node.js erforderlich.

---

## Verfügbare MCP-Tools

| Tool | Beschreibung |
|------|-------------|
| `test_connection` | Verbindung + TLS-Status prüfen |
| `list_schemas` | Alle Schemas anzeigen |
| `list_tables` | Tabellen eines Schemas |
| `describe_table` | Spalten, Typen, Constraints |
| `query` | SELECT ausführen (max. 200 Zeilen) |
| `execute` | INSERT / UPDATE / DELETE / DDL |

---

## Endpoints

| Path | Auth | Beschreibung |
|------|------|-------------|
| `POST /mcp` | Admin- oder DB-Token | MCP Streamable-HTTP |
| `GET /health` | keine | Health-Check (`{"status":"ok","tls":<bool>}`) |
| `GET /admin/tokens` | nur Admin-Token | Token auflisten |
| `POST /admin/tokens` | nur Admin-Token | Token erstellen |
| `PATCH /admin/tokens/:id` | nur Admin-Token | Token umbenennen / de-/aktivieren |
| `DELETE /admin/tokens/:id` | nur Admin-Token | Token deaktivieren |
