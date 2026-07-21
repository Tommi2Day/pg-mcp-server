#!/bin/sh
set -e

TLS_ENABLED="${TLS_ENABLED:-false}"
CERT="${TLS_CERT_FILE:-/certs/tls.crt}"
KEY="${TLS_KEY_FILE:-/certs/tls.key}"

if [ "$TLS_ENABLED" = "true" ]; then
  if [ -f "$CERT" ] && [ -f "$KEY" ]; then
    echo "✅ TLS certificate found at $CERT – using existing cert."
    # Container runs as uid 1000 (node), so a restrictively-mounted cert
    # (e.g. root:root 600) can only be fixed if we own it or it's already readable.
    chmod o+r "$CERT" "$KEY" 2>/dev/null || {
      echo "   ❌ Cannot make certs readable for the node user (uid 1000)."
      echo "      Mount certs with mode 644 (key: 640+) and owned by uid 1000, or world-readable."
      exit 1
    }
  else
    echo "⚠️  No TLS certificate found at $CERT / $KEY"
    echo "   Generating a self-signed certificate with SAN (NOT for production use)..."
    mkdir -p "$(dirname "$CERT")"

    SAN="DNS:localhost,IP:127.0.0.1"
    if [ -n "$HOSTNAME" ] && [ "$HOSTNAME" != "localhost" ]; then
      SAN="${SAN},DNS:${HOSTNAME}"
    fi
    if [ -n "$TLS_SAN" ]; then
      SAN="${SAN},${TLS_SAN}"
    fi
    echo "   SANs: $SAN"

    openssl req -x509 -newkey rsa:4096 \
      -keyout "$KEY" -out "$CERT" \
      -days 365 -nodes \
      -subj "/CN=pg-mcp-server" \
      -addext "subjectAltName=${SAN}" \
      2>/dev/null

    chmod 644 "$CERT"
    chmod 640 "$KEY"
    echo "   ✅ Self-signed certificate generated."
    echo "   → For production: mount real certs via -v /host/certs:/certs"
  fi
else
  echo "ℹ️  TLS disabled – running plain HTTP."
fi

# Ensure the token store directory exists. The image pre-creates /data owned
# by node so a fresh named volume / emptyDir inherits that ownership; a
# volume mounted with different ownership needs to already be writable by
# uid 1000 since the container no longer runs as root.
mkdir -p "$(dirname "${TOKENS_FILE:-/data/tokens.json}")"

exec node index.js
