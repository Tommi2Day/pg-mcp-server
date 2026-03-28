#!/usr/bin/env bash
# Führt ESLint via Docker aus (kein lokales Node.js erforderlich)
#
# Usage:
#   ./lint.sh              # alle Dateien
#   ./lint.sh --fix        # Fehler automatisch beheben
#   ./lint.sh lib.js       # einzelne Datei
set -eo pipefail

# pwd -W gibt Windows-Pfade (C:/...) in Git Bash zurück – nötig für Docker-Volume-Mounts
DIR="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

docker run --rm \
  -v "${DIR}:/app" \
  -v "pg-mcp-npm-cache:/root/.npm" \
  node:22-alpine \
  sh -c 'cd /app && npm ci --silent && if [ $# -gt 0 ]; then npx eslint "$@"; else npx eslint .; fi' -- "$@"
