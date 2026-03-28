#!/usr/bin/env bash
# Führt Coverage-Report via Docker aus (kein lokales Node.js erforderlich)
#
# Usage:
#   ./coverage.sh            # Coverage-Report erstellen (Ausgabe in ./coverage/)
#   ./coverage.sh --open     # Report erstellen und im Browser öffnen
set -eo pipefail

OPEN=false
if [ "$1" = "--open" ]; then
  OPEN=true
fi

# pwd -W gibt Windows-Pfade (C:/...) in Git Bash zurück – nötig für Docker-Volume-Mounts
DIR="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

docker run --rm \
  -v "${DIR}:/app" \
  -v "pg-mcp-npm-cache:/root/.npm" \
  node:22-alpine \
  sh -c 'cd /app && npm ci --silent && npx vitest run --coverage'

if [ "$OPEN" = true ]; then
  REPORT="${DIR}/coverage/index.html"
  if [ -f "$REPORT" ]; then
    echo "Opening coverage report: $REPORT"
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$REPORT"
    elif command -v open >/dev/null 2>&1; then
      open "$REPORT"
    else
      start "$REPORT" 2>/dev/null || echo "Open manually: $REPORT"
    fi
  else
    echo "Coverage report not found at: $REPORT"
  fi
fi
