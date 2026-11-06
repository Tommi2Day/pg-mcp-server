FROM node:24-alpine AS deps

WORKDIR /app
COPY ["package.json","package-lock.json", "/app/"]
RUN npm ci --omit=dev

FROM node:24-alpine

RUN apk upgrade --no-cache && apk add --no-cache openssl curl \
    # npm/npx/corepack are not needed at runtime (and carry their own bundled-package CVEs)
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*

WORKDIR /app

COPY ["package.json","package-lock.json","docker-entrypoint.sh", "/app/"]
COPY --from=deps /app/node_modules /app/node_modules
COPY src/ /app/src/
RUN chmod +x /app/docker-entrypoint.sh
RUN mkdir -p /certs /data && chown -R node:node /certs /data

ENV TRANSPORT=http \
    PORT=3000 \
    TLS_ENABLED=false \
    TLS_CERT_FILE=/certs/tls.crt \
    TLS_KEY_FILE=/certs/tls.key \
    PG_HOST=localhost \
    PG_PORT=5432 \
    PG_DATABASE=postgres \
    PG_USER=postgres \
    PG_PASSWORD="" \
    PG_SSL=false

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || wget -qO- --no-check-certificate https://localhost:3000/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
