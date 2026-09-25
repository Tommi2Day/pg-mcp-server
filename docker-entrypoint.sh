#!/bin/sh
set -e

TLS_ENABLED="${TLS_ENABLED:-false}"
CERT="${TLS_CERT_FILE:-/certs/tls.crt}"
KEY="${TLS_KEY_FILE:-/certs/tls.key}"
SELF_SIGNED_CN="pg-mcp-server"

generate_self_signed() {
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
    -subj "/CN=${SELF_SIGNED_CN}" \
    -addext "subjectAltName=${SAN}" \
    2>/dev/null

  chmod 644 "$CERT"
  chmod 640 "$KEY"
  echo "   ✅ Self-signed certificate generated."
  echo "   → For production: mount real certs via -v /host/certs:/certs"
}

# True if $CERT is a self-signed cert created by this script (subject == issuer == CN=pg-mcp-server).
# Only those are ever regenerated — user-provided certs are left alone.
is_own_self_signed() {
  subject=$(openssl x509 -in "$CERT" -noout -subject -nameopt RFC2253 2>/dev/null) || return 1
  issuer=$(openssl x509 -in "$CERT" -noout -issuer -nameopt RFC2253 2>/dev/null) || return 1
  [ "${subject#subject=}" = "CN=${SELF_SIGNED_CN}" ] && [ "${issuer#issuer=}" = "CN=${SELF_SIGNED_CN}" ]
}

if [ "$TLS_ENABLED" = "true" ]; then
  if [ -f "$CERT" ] && [ -f "$KEY" ]; then
    # Certs live on a persistent volume, so a generated cert would otherwise expire after a year.
    if is_own_self_signed && ! openssl x509 -in "$CERT" -noout -checkend 2592000 >/dev/null 2>&1; then
      echo "⚠️  Self-signed certificate at $CERT expires within 30 days (or has expired)."
      generate_self_signed
    else
      echo "✅ TLS certificate found at $CERT – using existing cert."
    fi
    # Container runs as uid 1000 (node) and can only chmod files it owns.
    # Cert may be world-readable; the private key must not be — only owner/group.
    [ -r "$CERT" ] || chmod o+r "$CERT" 2>/dev/null || true
    if [ -O "$KEY" ]; then
      chmod 640 "$KEY"
    fi
    if [ ! -r "$CERT" ] || [ ! -r "$KEY" ]; then
      echo "   ❌ TLS cert/key not readable for the node user (uid 1000)."
      echo "      Mount certs owned by uid 1000 (key mode 600/640), or with group 1000 and key mode 640."
      exit 1
    fi
  else
    echo "⚠️  No TLS certificate found at $CERT / $KEY"
    generate_self_signed
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
