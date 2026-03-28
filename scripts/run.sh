#!/bin/bash
NAME=${1:-pg-mcp-server}
if [ -r .env ]; then
  . .env
fi
if [ "$(docker ps -q -f name=$NAME)" ]; then
  docker stop $NAME
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
docker run -d --name $NAME \
  -p $MCP_PORT:3000 \
  -e TRANSPORT=http \
  -e AUTH_TOKEN=$AUTH_TOKEN \
  -e PG_HOST=$PG_HOST \
  -e PG_PORT=$PG_PORT \
  -e PG_DATABASE=$PG_DATABASE \
  -e PG_USER=$PG_USER \
  -e PG_PASSWORD=$PG_PASSWORD \
  -e PG_SSL=prefer \
  tommi2day/pg-mcp-server:latest
