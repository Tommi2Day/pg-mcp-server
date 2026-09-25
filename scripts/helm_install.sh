#!/usr/bin/env bash
# Helm Install / Upgrade für pg-mcp-server
# Anpassen: Variablen im Abschnitt "Konfiguration" setzen oder per Umgebung /
# defaults.env (optional, standortspezifische Vorgaben) / .env überschreiben.
set -euo pipefail
[ -r defaults.env ] && . ./defaults.env
[ -r .env ] && . ./.env

# ── Konfiguration ─────────────────────────────────────────────────────────────
RELEASE="${RELEASE:-pg-mcp}"
NAMESPACE="${NAMESPACE:-mcp}"
CHART="${CHART:-./helm/pg-mcp-server}"
IMAGE_REPO="${IMAGE_REPO:-tommi2day/pg-mcp-server}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
# Zusätzliche values-Dateien, durch Leerzeichen getrennt (z. B. "helm/values-prod.yaml")
HELM_VALUES_FILES="${HELM_VALUES_FILES:-}"

PG_HOST="${PG_HOST:-mein-db-host}"
PG_PORT="${PG_PORT:-5432}"
PG_DATABASE="${PG_DATABASE:-meine_db}"
PG_USER="${PG_USER:-mein_user}"
PG_PASSWORD="${PG_PASSWORD:-mein_passwort}"
PG_SSL="${PG_SSL:-false}"

# Auth-Token generieren falls nicht gesetzt
AUTH_TOKEN="${AUTH_TOKEN:-$(openssl rand -hex 32)}"

# ── Helm install / upgrade ────────────────────────────────────────────────────
VALUES_ARGS=()
for f in ${HELM_VALUES_FILES}; do VALUES_ARGS+=(-f "$f"); done

helm upgrade --install "${RELEASE}" "${CHART}" \
  --namespace "${NAMESPACE}" --create-namespace \
  "${VALUES_ARGS[@]}" \
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
