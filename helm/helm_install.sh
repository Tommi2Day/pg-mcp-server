#!/usr/bin/env bash
# Helm Install / Upgrade für pg-mcp-server
# Anpassen: Variablen im Abschnitt "Konfiguration" setzen
set -euo pipefail

# ── Konfiguration ─────────────────────────────────────────────────────────────
RELEASE="pg-mcp"
NAMESPACE="mcp"
CHART="./helm/pg-mcp-server"
IMAGE_REPO="tommi2day/pg-mcp-server"
IMAGE_TAG="latest"

PG_HOST="mein-db-host"
PG_PORT="5432"
PG_DATABASE="meine_db"
PG_USER="mein_user"
PG_PASSWORD="mein_passwort"
PG_SSL="false"

# Auth-Token generieren falls nicht gesetzt
AUTH_TOKEN="${AUTH_TOKEN:-$(openssl rand -hex 32)}"

# ── Helm install / upgrade ────────────────────────────────────────────────────
helm upgrade --install "${RELEASE}" "${CHART}" \
  --namespace "${NAMESPACE}" --create-namespace \
  --set image.repository="${IMAGE_REPO}" \
  --set image.tag="${IMAGE_TAG}" \
  --set postgresql.host="${PG_HOST}" \
  --set postgresql.port="${PG_PORT}" \
  --set postgresql.database="${PG_DATABASE}" \
  --set postgresql.user="${PG_USER}" \
  --set postgresql.password="${PG_PASSWORD}" \
  --set postgresql.ssl="${PG_SSL}" \
  --set auth.token="${AUTH_TOKEN}"

echo ""
echo "✅ ${RELEASE} deployed in namespace '${NAMESPACE}'"
echo ""
echo "   Admin-Token (sicher aufbewahren!):"
echo "   AUTH_TOKEN=${AUTH_TOKEN}"
echo ""
echo "   MCP-Endpoint:"
echo "   http://$(kubectl get svc -n ${NAMESPACE} ${RELEASE}-pg-mcp-server -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo '<ClusterIP>'):3000/mcp"
