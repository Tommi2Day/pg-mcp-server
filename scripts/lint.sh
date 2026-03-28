#!/usr/bin/env bash
# Runs ESLint via Docker (no local Node.js required)
#
# Usage:
#   ./lint.sh              # all files
#   ./lint.sh --fix        # auto-fix issues
#   ./lint.sh lib.js       # single file
set -eo pipefail

# pwd -W returns Windows paths (C:/...) in Git Bash – required for Docker volume mounts
DIR="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"

docker run --rm \
  -v "${DIR}:/app" \
  -v "pg-mcp-npm-cache:/root/.npm" \
  node:22-alpine \
  sh -c 'cd /app && npm ci --silent && if [ $# -gt 0 ]; then npx eslint "$@"; else npx eslint .; fi' -- "$@"
