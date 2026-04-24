#!/usr/bin/env node
/**
 * PostgreSQL MCP Server
 *
 * Transport modes (TRANSPORT env var):
 *   stdio  – local Claude Desktop via stdio (no TLS needed)
 *   http   – HTTP or HTTPS depending on TLS_ENABLED
 *
 * TLS for HTTP (TLS_ENABLED):
 *   true   – HTTPS, requires TLS_CERT_FILE + TLS_KEY_FILE
 *   false  – plain HTTP (default for easy local/dev use)
 *
 * PostgreSQL TLS (PG_SSL):
 *   false   – no TLS
 *   true    – TLS, skip server cert verification
 *   verify  – TLS + verify server cert (requires PG_SSL_CA_FILE)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  readFileEnv, buildPgSsl, getAuthToken,
  checkAuth, handleAdminRequest,
} from "./lib.js";

const { Pool } = pg;
const { version } = createRequire(import.meta.url)("./package.json");
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

// ── DB pool (only when run directly) ─────────────────────────────────────────
export let pool;
if (isMain) {
  pool = new Pool({
    host:     process.env.PG_HOST     || "localhost",
    port:     parseInt(process.env.PG_PORT || "5432"),
    database: process.env.PG_DATABASE || "postgres",
    user:     process.env.PG_USER     || "postgres",
    password: process.env.PG_PASSWORD || "",
    ssl:      buildPgSsl(),
    connectionTimeoutMillis: 10000,
    max: 5,
  });
  pool.on?.("error", (err) => {
    console.error(`[${new Date().toISOString()}] [DB] Pool error: ${err.message}`);
  });
}

// ── Per-token pool cache ──────────────────────────────────────────────────────
export const poolCache = new Map(); // JSON key → Pool instance

/** Build a simple ssl config from a token connection's ssl field (no file loading). */
function sslFromValue(val) {
  if (!val || val === "false" || val === false || val === "0" || val === "no" || val === "prefer") return false;
  return { rejectUnauthorized: false };
}

/** Return the pool for the given connection config, or the admin pool if null. */
export function getPool(connection) {
  if (!connection) return pool;
  const key = JSON.stringify(connection);
  if (!poolCache.has(key)) {
    const p = new Pool({
      host:     connection.host     || process.env.PG_HOST     || "localhost",
      port:     parseInt(connection.port     || process.env.PG_PORT     || "5432"),
      database: connection.database || process.env.PG_DATABASE || "postgres",
      user:     connection.user     || process.env.PG_USER     || "postgres",
      password: connection.password || process.env.PG_PASSWORD || "",
      ssl:      sslFromValue(connection.ssl),
      connectionTimeoutMillis: 10000,
      max: 5,
    });
    p.on?.("error", (err) => {
      console.error(`[${new Date().toISOString()}] [DB] Pool error (${connection.host || "default"}): ${err.message}`);
    });
    poolCache.set(key, p);
  }
  return poolCache.get(key);
}

// ── MCP server factory ────────────────────────────────────────────────────────
export function createMcpServer(dbPool = pool, tokenName = "unknown", clientIp = "-") {
  const server = new Server(
    { name: "pg-mcp-server", version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "query",
        description: "Execute a SQL SELECT query and return results",
        inputSchema: {
          type: "object",
          properties: {
            sql:    { type: "string", description: "SQL SELECT query" },
            params: { type: "array", items: {}, description: "Query parameters ($1, $2, …)" },
          },
          required: ["sql"],
        },
      },
      {
        name: "execute",
        description: "Execute a SQL statement (INSERT, UPDATE, DELETE, DDL)",
        inputSchema: {
          type: "object",
          properties: {
            sql:    { type: "string", description: "SQL statement" },
            params: { type: "array", items: {}, description: "Query parameters ($1, $2, …)" },
          },
          required: ["sql"],
        },
      },
      {
        name: "list_tables",
        description: "List all tables in a schema",
        inputSchema: {
          type: "object",
          properties: {
            schema: { type: "string", description: "Schema name (default: public)", default: "public" },
          },
        },
      },
      {
        name: "describe_table",
        description: "Show columns, types and constraints of a table",
        inputSchema: {
          type: "object",
          properties: {
            table:  { type: "string", description: "Table name" },
            schema: { type: "string", description: "Schema name (default: public)", default: "public" },
          },
          required: ["table"],
        },
      },
      {
        name: "list_schemas",
        description: "List all schemas in the database",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "test_connection",
        description: "Test the database connection and return server info",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const argsStr = args && Object.keys(args).length ? " params=" + JSON.stringify(args) : "";
    console.error(`[${new Date().toISOString()}] [MCP] token="${tokenName}" action="${name}" ip="${clientIp}"${argsStr}`);
    try {
      switch (name) {
        case "test_connection": {
          // noinspection SqlNoDataSourceInspection
          const res = await dbPool.query(
            "SELECT version(), current_database(), current_user, now(), ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
          ).catch(() => {
            // noinspection SqlNoDataSourceInspection
            return dbPool.query("SELECT version(), current_database(), current_user, now()");
          });
          const r = res.rows[0];
          const sslStatus = r.ssl !== undefined ? (r.ssl ? "✅ encrypted" : "⚠️ unencrypted") : "unknown";
          return { content: [{ type: "text", text:
            `✅ Connection successful!\n\nDatabase   : ${r.current_database}\nUser       : ${r.current_user}\nTime       : ${r.now}\nDB TLS     : ${sslStatus}\nVersion    : ${r.version}` }] };
        }
        case "list_schemas": {
          // noinspection SqlNoDataSourceInspection
          const res = await dbPool.query(
            `SELECT schema_name FROM information_schema.schemata
             WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
             ORDER BY schema_name`
          );
          return { content: [{ type: "text", text: `Schemas:\n${res.rows.map(r => r.schema_name).join("\n")}` }] };
        }
        case "list_tables": {
          const schema = args.schema || "public";
          // noinspection SqlNoDataSourceInspection
          const res = await dbPool.query(
            `SELECT table_name, table_type FROM information_schema.tables
             WHERE table_schema = $1 ORDER BY table_type, table_name`, [schema]
          );
          if (!res.rows.length) return { content: [{ type: "text", text: `No tables in schema "${schema}".` }] };
          return { content: [{ type: "text", text:
            `Tables in "${schema}":\n${res.rows.map(r => `  ${r.table_type === "VIEW" ? "VIEW" : "TABLE"}: ${r.table_name}`).join("\n")}` }] };
        }
        case "describe_table": {
          const schema = args.schema || "public";
          // noinspection SqlNoDataSourceInspection
          const res = await dbPool.query(
            `SELECT c.column_name, c.data_type, c.character_maximum_length, c.is_nullable, c.column_default,
                    CASE WHEN pk.column_name IS NOT NULL THEN 'PK' ELSE '' END AS key
             FROM information_schema.columns c
             LEFT JOIN (
               SELECT ku.column_name FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage ku
                 ON tc.constraint_name = ku.constraint_name AND tc.table_schema = ku.table_schema
               WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND tc.table_schema = $2
             ) pk ON pk.column_name = c.column_name
             WHERE c.table_name = $1 AND c.table_schema = $2
             ORDER BY c.ordinal_position`, [args.table, schema]
          );
          if (!res.rows.length) return { content: [{ type: "text", text: `Table "${schema}.${args.table}" not found.` }] };
          const rows = res.rows.map(r => {
            const type = r.character_maximum_length ? `${r.data_type}(${r.character_maximum_length})` : r.data_type;
            return `${r.column_name} | ${type} | ${r.is_nullable} | ${r.column_default ?? ""} | ${r.key}`;
          });
          return { content: [{ type: "text", text:
            `Table: ${schema}.${args.table}\n${"─".repeat(60)}\nColumn | Type | Nullable | Default | Key\n${"─".repeat(60)}\n${rows.join("\n")}` }] };
        }
        case "query": {
          const res = await dbPool.query(args.sql, args.params || []);
          if (!res.rows.length) return { content: [{ type: "text", text: "Query returned 0 rows." }] };
          const cols = Object.keys(res.rows[0]);
          const header = cols.join(" | ");
          const rows = res.rows.slice(0, 200).map(r => cols.map(c => String(r[c] ?? "")).join(" | "));
          const note = res.rows.length > 200 ? `\n(showing 200 of ${res.rows.length} rows)` : `\n(${res.rows.length} row${res.rows.length !== 1 ? "s" : ""})`;
          return { content: [{ type: "text", text: `${header}\n${"─".repeat(Math.min(header.length, 120))}\n${rows.join("\n")}${note}` }] };
        }
        case "execute": {
          const res = await dbPool.query(args.sql, args.params || []);
          return { content: [{ type: "text", text: `✅ Statement executed.\nRows affected: ${res.rowCount ?? 0}` }] };
        }
        default:
          // noinspection ExceptionCaughtLocallyJS
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err?.message || err?.toString() || JSON.stringify(err);
      console.error(`[${new Date().toISOString()}] [MCP] token="${tokenName}" action="${name}" ip="${clientIp}" error=${JSON.stringify(msg)}`);
      return { content: [{ type: "text", text: `❌ Error: ${msg}` }], isError: true };
    }
  });

  return server;
}

// ── Session store (stateful HTTP sessions) ────────────────────────────────────
export const sessions = new Map(); // sessionId → StreamableHTTPServerTransport

// ── Request handler (shared by both HTTP and HTTPS) ───────────────────────────
export async function handleRequest(req, res) {
  try {
    await _handleRequest(req, res);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [HTTP] Unhandled error for ${req.method} ${req.url}: ${err.message}`);
    if (err.stack) console.error(err.stack);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}

async function _handleRequest(req, res) {
  if ((req.url === "/admin" || req.url === "/admin/") && req.method === "GET") {
    try {
      const html = fs.readFileSync(new URL("./admin.html", import.meta.url));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [HTTP] Failed to read admin.html: ${err.message}`);
      res.writeHead(404);
      res.end("Admin UI not found");
    }
    return;
  }
  if (req.url === "/health" && req.method === "GET") {
    const tlsEnabled = process.env.TLS_ENABLED !== "false";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", tls: tlsEnabled }));
    return;
  }
  if (req.url === "/info" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      version,
      db: {
        host:     process.env.PG_HOST     || "localhost",
        port:     parseInt(process.env.PG_PORT || "5432"),
        database: process.env.PG_DATABASE || "postgres",
        user:     process.env.PG_USER     || "postgres",
        ssl:      process.env.PG_SSL      || "false",
      },
    }));
    return;
  }
  if (req.url?.startsWith("/admin/tokens")) {
    await handleAdminRequest(req, res);
    return;
  }
  if (req.url === "/mcp") {
    const auth = await checkAuth(req, res);
    if (!auth.ok) return;

    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
      // Resume existing session
      await sessions.get(sessionId).handleRequest(req, res);
    } else {
      // New session — resolve pool for this token
      const dbPool = getPool(auth.connection);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, transport); },
      });
      transport.onclose = () => { sessions.delete(sessionId); };
      const clientIp = req.headers["x-real-ip"]
        || req.headers["x-forwarded-for"]?.split(",")[0].trim()
        || req.socket?.remoteAddress || "-";
      const server = createMcpServer(dbPool, auth.name, clientIp);
      await server.connect(transport);
      await transport.handleRequest(req, res);
    }
    return;
  }
  res.writeHead(404);
  res.end("Not found");
}

// ── Process-level error handlers (only when run directly) ────────────────────
if (isMain) {
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[${new Date().toISOString()}] [FATAL] Unhandled rejection: ${msg}`);
    if (reason instanceof Error && reason.stack) console.error(reason.stack);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[${new Date().toISOString()}] [FATAL] Uncaught exception: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

// ── Transport selection (only when run directly) ──────────────────────────────
if (isMain) {
  const TRANSPORT   = (process.env.TRANSPORT   || "stdio").toLowerCase();
  const TLS_ENABLED = (process.env.TLS_ENABLED || "false").toLowerCase() !== "false";
  const PORT        = parseInt(process.env.PORT || "3000");

  if (TRANSPORT === "http") {
    const authInfo = getAuthToken()
      ? "🔑 Bearer token required (env + file tokens)"
      : "⚠️  disabled (AUTH_TOKEN not set)";

    if (TLS_ENABLED) {
      // ── HTTPS ─────────────────────────────────────────────────────────────
      const cert = readFileEnv("TLS_CERT_FILE");
      const key  = readFileEnv("TLS_KEY_FILE");
      if (!cert || !key) {
        console.error("❌ TLS_ENABLED=true requires TLS_CERT_FILE and TLS_KEY_FILE.");
        process.exit(1);
      }
      const tlsOptions = { cert, key };
      const ca = readFileEnv("TLS_CA_FILE");
      if (ca) {
        tlsOptions.ca = ca;
        tlsOptions.requestCert = true;
        tlsOptions.rejectUnauthorized = true;
        console.error("🔐 mTLS enabled – client certificates required.");
      }
      https.createServer(tlsOptions, handleRequest).listen(PORT, () => {
        console.error(`PostgreSQL MCP Server (HTTPS) listening on port ${PORT}`);
        console.error(`  MCP endpoint : https://localhost:${PORT}/mcp`);
        console.error(`  Admin UI     : https://localhost:${PORT}/admin`);
        console.error(`  Admin API    : https://localhost:${PORT}/admin/tokens`);
        console.error(`  Health check : https://localhost:${PORT}/health`);
        console.error(`  Server info  : https://localhost:${PORT}/info`);
        console.error(`  Auth         : ${authInfo}`);
      });
    } else {
      // ── HTTP ───────────────────────────────────────────────────────────────
      http.createServer(handleRequest).listen(PORT, () => {
        console.error(`PostgreSQL MCP Server (HTTP) listening on port ${PORT}`);
        console.error(`  MCP endpoint : http://localhost:${PORT}/mcp`);
        console.error(`  Admin UI     : http://localhost:${PORT}/admin`);
        console.error(`  Admin API    : http://localhost:${PORT}/admin/tokens`);
        console.error(`  Health check : http://localhost:${PORT}/health`);
        console.error(`  Server info  : http://localhost:${PORT}/info`);
        console.error(`  Auth         : ${authInfo}`);
      });
    }
  } else {
    // ── stdio ─────────────────────────────────────────────────────────────────
    const server    = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("PostgreSQL MCP Server running on stdio");
  }
}
