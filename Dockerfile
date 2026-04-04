FROM node:25-alpine

RUN apk add --no-cache openssl su-exec curl

WORKDIR /app

COPY ["package.json","package-lock.json","index.js","lib.js","admin.html","docker-entrypoint.sh", "/app/"]
RUN npm install --omit=dev && chmod +x /app/docker-entrypoint.sh
RUN mkdir -p /certs && chmod 777 /certs

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

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || wget -qO- --no-check-certificate https://localhost:3000/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
