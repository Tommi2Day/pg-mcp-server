#!/usr/bin/env bash
# Führt Unit-Tests via Docker aus (kein lokales Node.js erforderlich)
#
# Usage:
#   ./test.sh                        # alle Tests
#   ./test.sh tests/lib.test.js      # einzelne Datei
#   ./test.sh --reporter=verbose     # vitest-Optionen
set -eo pipefail

# pwd -W gibt Windows-Pfade (C:/...) in Git Bash zurück – nötig für Docker-Volume-Mounts
DIR="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

docker run --rm \
  -v "${DIR}:/app" \
  -v "pg-mcp-npm-cache:/root/.npm" \
  node:22-alpine \
  sh -c 'cd /app && npm ci --silent && npx vitest run "$@"' -- "$@"
