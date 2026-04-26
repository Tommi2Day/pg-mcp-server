#!/bin/sh
set -e

TLS_ENABLED="${TLS_ENABLED:-false}"
CERT="${TLS_CERT_FILE:-/certs/tls.crt}"
KEY="${TLS_KEY_FILE:-/certs/tls.key}"

if [ "$TLS_ENABLED" = "true" ]; then
  if [ -f "$CERT" ] && [ -f "$KEY" ]; then
    echo "✅ TLS certificate found at $CERT – using existing cert."
    # Ensure the node user can read both files (handles root:root 600 mounts)
    chmod o+r "$CERT" "$KEY" 2>/dev/null || \
      chown node:node "$CERT" "$KEY" 2>/dev/null || {
        echo "   ❌ Cannot make certs readable for node user."
        echo "      Ensure files are mode 644 or owned by uid 1000."
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

    chown node:node "$CERT" "$KEY"
    chmod 644 "$CERT"
    chmod 640 "$KEY"
    echo "   ✅ Self-signed certificate generated."
    echo "   → For production: mount real certs via -v /host/certs:/certs"
  fi
else
  echo "ℹ️  TLS disabled – running plain HTTP."
fi

# Ensure the token store directory is writable by the node user (uid 1000).
# Named Docker volumes are created owned by root; chown before dropping privileges.
_data_dir="$(dirname "${TOKENS_FILE:-/data/tokens.json}")"
mkdir -p "$_data_dir"
chown node:node "$_data_dir"

# Drop from root to node user
exec su-exec node node index.js
