#!/bin/bash
# Pulls and starts the pg-mcp-server Docker container.
# Auto-generates AUTH_TOKEN on first run (saved to ./auth_token).
# Reads .env from the project root if present.
#
# Usage:
#   ./run.sh              # start as "pg-mcp-server"
#   ./run.sh my-name      # start with a custom container name
NAME=${1:-pg-mcp-server}
if [ -r .env ]; then
  . .env
fi
if [ "$(docker ps -a -q -f name=$NAME)" ]; then
  docker stop $NAME
  sleep 10
  docker rm $NAME
fi
if [ ! -r ./auth_token ]; then
  openssl rand -hex 32 > ./auth_token
fi
AUTH_TOKEN=$(cat ./auth_token)
PG_HOST=${PGHOST:-localhost}
PG_PORT=${PGPORT:-5432}
PG_DATABASE=${PGDATABASE:-postgres}
PG_USER=${PGUSER:-postgres}
PG_PASSWORD=${PGPASSWORD:-}
MCP_PORT=${MCP_PORT:-3000}
MCP_SERVER_NAME=${MCP_SERVER_NAME:-}
docker pull tommi2day/pg-mcp-server:latest
docker run -d --name "$NAME" \
  -p "$MCP_PORT:3000" \
  -e TRANSPORT=http \
  -e "AUTH_TOKEN=$AUTH_TOKEN" \
  -e TOKENS_FILE=/data/tokens.json \
  -e "PG_HOST=$PG_HOST" \
  -e "PG_PORT=$PG_PORT" \
  -e "PG_DATABASE=$PG_DATABASE" \
  -e "PG_USER=$PG_USER" \
  -e "PG_PASSWORD=$PG_PASSWORD" \
  -e "PG_SSL=${PG_SSL:-false}" \
  ${MCP_SERVER_NAME:+-e "MCP_SERVER_NAME=$MCP_SERVER_NAME"} \
  -v "${NAME}-data:/data" \
  tommi2day/pg-mcp-server:latest

sleep 10
docker logs "$NAME"