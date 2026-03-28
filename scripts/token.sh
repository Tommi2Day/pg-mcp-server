#!/usr/bin/env bash
# Token management for pg-mcp-server
#
# Prerequisites:
#   AUTH_TOKEN  – Admin token (env var or .env file)
#   MCP_URL     – Server URL (default: http://localhost:3000)
#
# Usage:
#   ./token.sh list
#   ./token.sh add <name>
#   ./token.sh delete <id>
#   ./token.sh enable  <id>
#   ./token.sh disable <id>
#   ./token.sh rename  <id> <new-name>
set -eo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
# Load .env if present
if [ -f "$(dirname "$0")/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$(dirname "$0")/.env"; set +a
fi

ADMIN_TOKEN="${AUTH_TOKEN:-}"
BASE_URL="${MCP_URL:-http://localhost:3000}"
API="${BASE_URL}/admin/tokens"

# ── Helpers ───────────────────────────────────────────────────────────────────
die()  { echo "❌ $*" >&2; exit 1; }
info() { echo "ℹ️  $*"; }

require_token() {
  [ -n "$ADMIN_TOKEN" ] || die "AUTH_TOKEN not set.\nExport: export AUTH_TOKEN=<admin-token>\nOr add it to scripts/.env."
}

# curl with auth header; returns HTTP body + status code
api() {
  local method="$1"; shift
  local url="$1";    shift
  curl -sS -w "\n%{http_code}" \
    -X "$method" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    "$@" "$url"
}

# Separates body and status code (last line)
check_response() {
  local raw="$1"
  local status
  status=$(echo "$raw" | tail -n1)
  local body
  body=$(echo "$raw" | head -n -1)

  if [ "$status" -ge 400 ]; then
    local msg
    msg=$(echo "$body" | grep -o '"error":"[^"]*"' | head -1 | cut -d'"' -f4)
    die "HTTP ${status}: ${msg:-$body}"
  fi
  echo "$body"
}

# Minimal JSON pretty-print without external tools
pretty() {
  if command -v python3 >/dev/null 2>&1; then
    echo "$1" | python3 -m json.tool 2>/dev/null || echo "$1"
  elif command -v python >/dev/null 2>&1; then
    echo "$1" | python -m json.tool 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

# ── Subcommands ───────────────────────────────────────────────────────────────
cmd_list() {
  require_token
  local raw body
  raw=$(api GET "$API")
  body=$(check_response "$raw")

  echo ""
  printf "%-5s %-30s %-8s %-24s %-24s\n" "ID" "NAME" "ACTIVE" "CREATED" "LAST USED"
  printf "%-5s %-30s %-8s %-24s %-24s\n" "-----" "------------------------------" "--------" "------------------------" "------------------------"

  echo "$body" | grep -o '"id":[0-9]*\|"name":"[^"]*"\|"active":[^,}]*\|"created_at":"[^"]*"\|"last_used_at":[^,}]*' | \
  awk '
    /^"id":/ { id=substr($0,6) }
    /^"name":/ { gsub(/"name":"/, ""); gsub(/"/, ""); name=$0 }
    /^"active":/ { gsub(/"active":/, ""); active=$0 }
    /^"created_at":/ { gsub(/"created_at":"/, ""); gsub(/"/, ""); created=$0 }
    /^"last_used_at":/ {
      val=substr($0,15)
      gsub(/"/, "", val)
      last = (val == "null" || val == "") ? "-" : val
      printf "%-5s %-30s %-8s %-24s %-24s\n", id, name, active, substr(created,1,19), substr(last,1,19)
    }
  '
  echo ""
}

cmd_add() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./token.sh add <name>"
  local name="$1"

  local raw body
  raw=$(api POST "$API" -d "{\"name\":\"${name}\"}")
  body=$(check_response "$raw")

  local token
  token=$(echo "$body" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
  local id
  id=$(echo "$body" | grep -o '"id":[0-9]*' | cut -d':' -f2)

  echo ""
  echo "✅ Token created (ID: ${id}, Name: ${name})"
  echo ""
  echo "   TOKEN (shown once – copy it now!):"
  echo ""
  echo "   ${token}"
  echo ""
  echo "   .mcp.json entry:"
  echo "   \"headers\": { \"Authorization\": \"Bearer ${token}\" }"
  echo ""
}

cmd_delete() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./token.sh delete <id>"
  local id="$1"

  local raw body
  raw=$(api DELETE "${API}/${id}")
  body=$(check_response "$raw")
  echo "✅ Token ${id} deactivated."
}

cmd_enable() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./token.sh enable <id>"
  local id="$1"

  local raw body
  raw=$(api PATCH "${API}/${id}" -d '{"active":true}')
  body=$(check_response "$raw")
  echo "✅ Token ${id} enabled."
}

cmd_disable() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./token.sh disable <id>"
  local id="$1"

  local raw body
  raw=$(api PATCH "${API}/${id}" -d '{"active":false}')
  body=$(check_response "$raw")
  echo "✅ Token ${id} disabled."
}

cmd_rename() {
  require_token
  [ -n "${1:-}" ] || die "Usage: ./token.sh rename <id> <new-name>"
  [ -n "${2:-}" ] || die "Usage: ./token.sh rename <id> <new-name>"
  local id="$1" name="$2"

  local raw body
  raw=$(api PATCH "${API}/${id}" -d "{\"name\":\"${name}\"}")
  body=$(check_response "$raw")
  echo "✅ Token ${id} renamed to \"${name}\"."
}

cmd_help() {
  cat <<EOF

pg-mcp-server token management

  Configuration (env vars or scripts/.env):
    AUTH_TOKEN   Admin token (required)
    MCP_URL      Server URL  (default: http://localhost:3000)

  Commands:
    list                    List all tokens
    add    <name>           Create a new token
    delete <id>             Permanently deactivate a token
    enable <id>             Re-enable a token
    disable <id>            Temporarily disable a token
    rename <id> <name>      Rename a token

  Examples:
    export AUTH_TOKEN=<admin-token>
    ./token.sh list
    ./token.sh add "claude-desktop"
    ./token.sh delete 3

EOF
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "${1:-help}" in
  list)    cmd_list ;;
  add)     cmd_add    "${2:-}" ;;
  delete)  cmd_delete "${2:-}" ;;
  enable)  cmd_enable  "${2:-}" ;;
  disable) cmd_disable "${2:-}" ;;
  rename)  cmd_rename  "${2:-}" "${3:-}" ;;
  help|--help|-h) cmd_help ;;
  *) die "Unknown command: ${1}\nHelp: ./token.sh help" ;;
esac
