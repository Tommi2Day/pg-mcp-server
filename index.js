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
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  readFileEnv, buildPgSsl, getAuthToken,
  checkAuth, checkAdminAuth, handleAdminRequest, migrateTokenStore,
  log, isLogEnabled, getClientIp, getLogLevel,
} from "./lib.js";

const { Pool } = pg;
const { version } = createRequire(import.meta.url)("./package.json");
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

const mcpServerName = process.env.MCP_SERVER_NAME || "pg-mcp-server";

let cachedAdminHtml;
try {
  const raw = fs.readFileSync(new URL("./admin.html", import.meta.url), "utf8");
  cachedAdminHtml = Buffer.from(raw.replaceAll("__SERVER_NAME__", mcpServerName));
} catch { /* admin UI not available */ }

// ── DB pools ──────────────────────────────────────────────────────────────────
// One pool per (connection, token name): the token name is part of application_name,
// which PostgreSQL only accepts at connect time. Pools are created lazily.
export const poolCache = new Map(); // SHA-256 key → Pool instance

function connectionKey(connection, tokenName) {
  return createHash("sha256").update(JSON.stringify({ connection: connection ?? null, tokenName })).digest("hex");
}

/** application_name for the server's database sessions: "<MCP_SERVER_NAME>:<token name>".
 *  PostgreSQL keeps 63 bytes of printable ASCII, so other characters become "?". */
export function applicationName(tokenName) {
  return `${mcpServerName}:${tokenName}`.replace(/[^\x20-\x7e]/g, "?").slice(0, 63);
}

/** Build a simple ssl config from a token connection's ssl field (no file loading). */
function sslFromValue(val) {
  if (!val || val === "false" || val === false || val === "0" || val === "no" || val === "prefer") return false;
  return { rejectUnauthorized: false };
}

/** Return the pool for a token: its own connection config, or the server's default connection when null. */
export function getPool(connection, tokenName = "unknown") {
  const key = connectionKey(connection, tokenName);
  if (!poolCache.has(key)) {
    const conn = connection || {};
    const p = new Pool({
      host:     conn.host     || process.env.PG_HOST     || "localhost",
      port:     parseInt(conn.port     || process.env.PG_PORT     || "5432"),
      database: conn.database || process.env.PG_DATABASE || "postgres",
      user:     conn.user     || process.env.PG_USER     || "postgres",
      password: conn.password || process.env.PG_PASSWORD || "",
      ssl:      connection ? sslFromValue(connection.ssl) : buildPgSsl(),
      application_name: applicationName(tokenName),
      connectionTimeoutMillis: 10000,
      max: 5,
    });
    p.on?.("error", (err) => {
      log("error", "DB", `Pool error (token="${tokenName}" host=${conn.host || "default"}): ${err.message}`);
    });
    poolCache.set(key, p);
  }
  return poolCache.get(key);
}

/** Close and forget the pool of a token (after it was deleted). */
function closePool(connection, tokenName) {
  const key = connectionKey(connection, tokenName);
  const p = poolCache.get(key);
  if (p) { p.end().catch(() => {}); poolCache.delete(key); }
}

// ── Performance tool constants ────────────────────────────────────────────────
// Sort keys → ORDER BY expressions. Only these fixed strings ever reach the SQL text.
const TOP_QUERY_ORDER = {
  total_time:   "total_ms",
  mean_time:    "mean_ms",
  calls:        "calls",
  rows:         "rows",
  blocks_read:  "shared_blks_read",
  temp_written: "temp_blks_written",
};
const TABLE_STATS_ORDER = {
  size:         "pg_total_relation_size(s.relid)",
  seq_scan:     "s.seq_scan",
  seq_tup_read: "s.seq_tup_read",
  dead_rows:    "s.n_dead_tup",
};
const TUNING_SETTINGS = [
  "shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem", "max_connections",
  "random_page_cost", "seq_page_cost", "effective_io_concurrency", "default_statistics_target",
  "max_wal_size", "checkpoint_timeout", "checkpoint_completion_target", "wal_buffers",
  "autovacuum", "autovacuum_vacuum_scale_factor", "autovacuum_analyze_scale_factor",
  "max_parallel_workers_per_gather", "jit", "track_io_timing", "shared_preload_libraries",
];
const PERF_TOOL_NAMES = new Set(["explain_query", "top_queries", "table_stats", "index_health", "active_queries", "performance_overview"]);
/** Marker in the catalog queries of the performance tools; top_queries filters these out.
 *  pg_stat_statements drops leading comments, so it goes right after SELECT. */
const PERF_TAG = "/* pg-mcp-server:perf */";
const perfSql = (sql) => sql.replace(/^\s*SELECT\b/, `SELECT ${PERF_TAG}`);
const PRIVILEGE_ERROR = /permission denied|must be superuser|pg_read_all_stats|pg_monitor/i;
const PRIVILEGE_HINT = "\nHint: the performance tools need the pg_monitor role (GRANT pg_monitor TO <user>) — see docs/performance.md.";
// Filters the per-schema catalog queries; NULL = all user schemas.
const USER_SCHEMA = "n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND ($1::text IS NULL OR n.nspname = $1::text)";

// ── MCP server factory ────────────────────────────────────────────────────────
export function createMcpServer(dbPool, tokenName = "unknown", clientIp = "-") {
  const server = new Server(
    { name: mcpServerName, version },
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
      {
        name: "explain_query",
        description: "Show the execution plan of a single SQL statement. With analyze=true the statement is actually executed inside a read-only transaction that is always rolled back (writes are rejected)",
        inputSchema: {
          type: "object",
          properties: {
            sql:     { type: "string", description: "SQL statement to explain (without EXPLAIN)" },
            params:  { type: "array", items: {}, description: "Query parameters ($1, $2, …)" },
            analyze: { type: "boolean", description: "Execute the statement and report actual times and row counts (default: false)", default: false },
            buffers: { type: "boolean", description: "Include buffer usage (default: true when analyze=true)" },
            verbose: { type: "boolean", description: "Include output columns and schema-qualified names (default: false)", default: false },
            settings: { type: "boolean", description: "List planner-relevant settings that differ from the defaults (default: false)", default: false },
            generic_plan: { type: "boolean", description: "Plan a statement with unbound $1, $2, … placeholders without values (PostgreSQL 16+; not with analyze or params)", default: false },
            format:  { type: "string", enum: ["text", "json"], description: "Plan format (default: text)", default: "text" },
          },
          required: ["sql"],
        },
      },
      {
        name: "top_queries",
        description: "List the most expensive statements of the current database from pg_stat_statements (requires the extension). queryid matches query_id in active_queries",
        inputSchema: {
          type: "object",
          properties: {
            order_by:      { type: "string", enum: Object.keys(TOP_QUERY_ORDER), description: "Sort key (default: total_time)", default: "total_time" },
            sql_text_like: { type: "string", description: "Only statements whose text contains this string (case-insensitive)" },
            user:          { type: "string", description: "Only statements executed by this role" },
            limit:         { type: "integer", description: "Number of statements (default: 10, max: 100)", default: 10 },
          },
        },
      },
      {
        name: "table_stats",
        description: "Without table: sizes, sequential vs. index scans, dead tuples and last vacuum/analyze times of many tables. "
          + "With table: details of one table — stale/missing statistics warnings, indexes with definitions and usage, "
          + "per-column planner statistics (null fraction, distinct values, correlation, most common values)",
        inputSchema: {
          type: "object",
          properties: {
            table:    { type: "string", description: "Table name for the detail view" },
            schema:   { type: "string", description: "Schema name (default: all user schemas; public for the detail view)" },
            order_by: { type: "string", enum: Object.keys(TABLE_STATS_ORDER), description: "Sort key of the overview (default: size)", default: "size" },
            limit:    { type: "integer", description: "Number of tables in the overview (default: 20, max: 200)", default: 20 },
          },
        },
      },
      {
        name: "index_health",
        description: "Find unused, duplicate and invalid indexes",
        inputSchema: {
          type: "object",
          properties: {
            schema: { type: "string", description: "Schema name (default: all user schemas)" },
          },
        },
      },
      {
        name: "active_queries",
        description: "Show running and idle-in-transaction sessions (blocked sessions first) with duration, wait event, blocking PIDs "
          + "and query_id, plus a snapshot of the wait events of all active sessions",
        inputSchema: {
          type: "object",
          properties: {
            min_duration_seconds: { type: "number", description: "Only sessions whose current statement or transaction runs at least this long (default: 0)", default: 0 },
            username: { type: "string", description: "Only sessions of this role" },
            limit:    { type: "integer", description: "Number of sessions (default: 50, max: 100)", default: 50 },
          },
        },
      },
      {
        name: "performance_overview",
        description: "Cache hit ratio, connections, temp files, deadlocks and key tuning settings of the current database",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log("info", "MCP", `token="${tokenName}" action="${name}" ip="${clientIp}"${formatToolParams(args)}`);
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
          const client = await dbPool.connect();
          let committed = false;
          try {
            await client.query("BEGIN READ ONLY");
            // Extended protocol: exactly one statement, so the SQL cannot end the read-only transaction.
            const res = await client.query({ text: args.sql, values: args.params || [], queryMode: "extended" });
            await client.query("COMMIT");
            committed = true;
            if (!res.rows.length) return { content: [{ type: "text", text: "Query returned 0 rows." }] };
            return { content: [{ type: "text", text: formatTable(res.rows) }] };
          } finally {
            if (!committed) await client.query("ROLLBACK").catch(() => {});
            client.release();
          }
        }
        case "execute": {
          const client = await dbPool.connect();
          let committed = false;
          try {
            await client.query("BEGIN");
            const res = await client.query(args.sql, args.params || []);
            await client.query("COMMIT");
            committed = true;
            return { content: [{ type: "text", text: `✅ Statement executed.\nRows affected: ${res.rowCount ?? 0}` }] };
          } finally {
            if (!committed) await client.query("ROLLBACK").catch(() => {});
            client.release();
          }
        }
        case "explain_query": {
          const analyze = args.analyze === true;
          const generic = args.generic_plan === true;
          if (generic && (analyze || args.params?.length)) throw new Error("generic_plan cannot be combined with analyze or params");
          const format  = args.format === "json" ? "JSON" : "TEXT";
          const options = [`ANALYZE ${analyze}`, `BUFFERS ${(args.buffers ?? analyze) === true}`, `VERBOSE ${args.verbose === true}`];
          if (args.settings === true) options.push("SETTINGS true");
          if (generic) options.push("GENERIC_PLAN true");
          options.push(`FORMAT ${format}`);
          const text = `EXPLAIN (${options.join(", ")}) ${String(args.sql).trim().replace(/;+\s*$/, "")}`;
          const client = await dbPool.connect();
          try {
            await client.query("BEGIN READ ONLY");
            let res;
            if (generic) await client.query("SAVEPOINT generic_plan");
            try {
              // Extended protocol: exactly one statement, so the SQL cannot end the read-only transaction.
              res = await client.query({ text, values: args.params || [], queryMode: "extended" });
            } catch (err) {
              // GENERIC_PLAN leaves $n unbound, which the extended protocol rejects at bind time. Parsing
              // already succeeded, so the text is a single statement and may run via the simple protocol.
              if (!generic || !/^bind message supplies 0 parameters/.test(err.message)) throw err;
              await client.query("ROLLBACK TO SAVEPOINT generic_plan");
              res = await client.query(text);
            }
            const plan = format === "JSON"
              ? JSON.stringify(res.rows[0]["QUERY PLAN"], null, 2)
              : res.rows.map(r => r["QUERY PLAN"]).join("\n");
            return { content: [{ type: "text", text: plan }] };
          } finally {
            // Always roll back: EXPLAIN ANALYZE really executes the statement.
            await client.query("ROLLBACK").catch(() => {});
            client.release();
          }
        }
        case "top_queries": {
          const order = TOP_QUERY_ORDER[args.order_by || "total_time"];
          if (!order) throw new Error(`Invalid order_by "${args.order_by}". Use one of: ${Object.keys(TOP_QUERY_ORDER).join(", ")}`);
          // noinspection SqlNoDataSourceInspection
          const probe = await dbPool.query(perfSql(
            `SELECT current_setting('server_version_num')::int AS version,
                    (SELECT quote_ident(n.nspname) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
                     WHERE e.extname = 'pg_stat_statements') AS schema`
          ));
          const { version: pgVersion, schema: extSchema } = probe.rows[0];
          if (!extSchema) return { content: [{ type: "text", text:
            "pg_stat_statements is not installed in this database.\nEnable it with shared_preload_libraries = 'pg_stat_statements' (server restart) and CREATE EXTENSION pg_stat_statements; — see docs/performance.md." }] };
          // Column names changed in PostgreSQL 13 (total_time → total_exec_time).
          const total = pgVersion >= 130000 ? "total_exec_time" : "total_time";
          const mean  = pgVersion >= 130000 ? "mean_exec_time"  : "mean_time";
          // noinspection SqlNoDataSourceInspection
          const [res, info] = await Promise.all([
            dbPool.query(perfSql(
              `SELECT s.queryid::text AS queryid, pg_get_userbyid(s.userid) AS user_name, s.calls,
                      round(s.${total}::numeric, 1) AS total_ms, round(s.${mean}::numeric, 2) AS mean_ms,
                      round((100 * s.${total} / nullif((SELECT sum(${total}) FROM ${extSchema}.pg_stat_statements WHERE dbid = s.dbid), 0))::numeric, 1) AS pct_total,
                      s.rows, round(100.0 * s.shared_blks_hit / nullif(s.shared_blks_hit + s.shared_blks_read, 0), 1) AS hit_pct,
                      s.shared_blks_read, s.temp_blks_written,
                      left(regexp_replace(s.query, '\\s+', ' ', 'g'), 300) AS query
               FROM ${extSchema}.pg_stat_statements s
               WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                 AND s.query NOT LIKE '%${PERF_TAG}%'
                 AND ($2::text IS NULL OR s.query ILIKE '%' || $2::text || '%')
                 AND ($3::text IS NULL OR pg_get_userbyid(s.userid) = $3::text)
               ORDER BY ${order} DESC NULLS LAST LIMIT $1`),
              [clampInt(args.limit, 10, 100), args.sql_text_like || null, args.user || null]),
            // pg_stat_statements_info exists from PostgreSQL 14 (extension 1.9); older extension versions lack it.
            pgVersion >= 140000
              ? dbPool.query(perfSql(
                `SELECT to_char(stats_reset, 'YYYY-MM-DD HH24:MI') AS stats_reset, dealloc
                 FROM ${extSchema}.pg_stat_statements_info`)).catch(() => null)
              : null,
          ]);
          const i = info?.rows?.[0];
          const since = i?.stats_reset ? ` since ${i.stats_reset}` : "";
          const evicted = Number(i?.dealloc) > 0
            ? `\nNote: ${i.dealloc} entries were evicted since the last reset — consider raising pg_stat_statements.max.` : "";
          if (!res.rows.length) return { content: [{ type: "text", text: `No pg_stat_statements entries match${since}.${evicted}` }] };
          return { content: [{ type: "text", text:
            `Top statements by ${args.order_by || "total_time"}${since}:\n${formatTable(res.rows)}${evicted}${privilegeNote(res.rows)}` }] };
        }
        case "table_stats": {
          if (args.table) return { content: [{ type: "text", text: await tableDetail(dbPool, args.schema || "public", args.table) }] };
          const order = TABLE_STATS_ORDER[args.order_by || "size"];
          if (!order) throw new Error(`Invalid order_by "${args.order_by}". Use one of: ${Object.keys(TABLE_STATS_ORDER).join(", ")}`);
          // noinspection SqlNoDataSourceInspection
          const res = await dbPool.query(perfSql(
            `SELECT s.schemaname || '.' || s.relname AS table_name,
                    pg_size_pretty(pg_total_relation_size(s.relid)) AS total_size,
                    pg_size_pretty(pg_relation_size(s.relid)) AS table_size,
                    pg_size_pretty(pg_indexes_size(s.relid)) AS index_size,
                    s.n_live_tup AS live_rows, s.n_dead_tup AS dead_rows,
                    round(100.0 * s.n_dead_tup / nullif(s.n_live_tup + s.n_dead_tup, 0), 1) AS dead_pct,
                    s.seq_scan, s.seq_tup_read, s.idx_scan,
                    to_char(greatest(s.last_vacuum, s.last_autovacuum), 'YYYY-MM-DD HH24:MI') AS last_vacuum,
                    to_char(greatest(s.last_analyze, s.last_autoanalyze), 'YYYY-MM-DD HH24:MI') AS last_analyze
             FROM pg_stat_user_tables s
             WHERE ($1::text IS NULL OR s.schemaname = $1::text)
             ORDER BY ${order} DESC NULLS LAST LIMIT $2`), [args.schema || null, clampInt(args.limit, 20, 200)]
          );
          if (!res.rows.length) return { content: [{ type: "text", text: args.schema ? `No tables in schema "${args.schema}".` : "No user tables found." }] };
          return { content: [{ type: "text", text: formatTable(res.rows) }] };
        }
        case "index_health": {
          const params = [args.schema || null];
          // noinspection SqlNoDataSourceInspection
          const [unused, duplicate, invalid, reset] = await Promise.all([
            dbPool.query(perfSql(
              `SELECT n.nspname || '.' || t.relname AS table_name, ic.relname AS index_name,
                      pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size, s.idx_scan
               FROM pg_stat_user_indexes s
               JOIN pg_index i ON i.indexrelid = s.indexrelid
               JOIN pg_class ic ON ic.oid = i.indexrelid
               JOIN pg_class t ON t.oid = i.indrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
                 AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
                 AND ${USER_SCHEMA}
               ORDER BY pg_relation_size(i.indexrelid) DESC`), params),
            dbPool.query(perfSql(
              `SELECT n.nspname || '.' || t.relname AS table_name,
                      string_agg(ic.relname, ', ' ORDER BY ic.relname) AS indexes,
                      pg_size_pretty(sum(pg_relation_size(i.indexrelid))::bigint) AS total_size
               FROM pg_index i
               JOIN pg_class ic ON ic.oid = i.indexrelid
               JOIN pg_class t ON t.oid = i.indrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               WHERE ${USER_SCHEMA}
               GROUP BY n.nspname, t.relname, i.indrelid, i.indkey::text, i.indclass::text, i.indcollation::text,
                        coalesce(pg_get_expr(i.indexprs, i.indrelid), ''), coalesce(pg_get_expr(i.indpred, i.indrelid), '')
               HAVING count(*) > 1
               ORDER BY sum(pg_relation_size(i.indexrelid)) DESC`), params),
            dbPool.query(perfSql(
              `SELECT n.nspname || '.' || t.relname AS table_name, ic.relname AS index_name
               FROM pg_index i
               JOIN pg_class ic ON ic.oid = i.indexrelid
               JOIN pg_class t ON t.oid = i.indrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               WHERE NOT i.indisvalid AND ${USER_SCHEMA}
               ORDER BY 1, 2`), params),
            dbPool.query(perfSql(
              `SELECT to_char(stats_reset, 'YYYY-MM-DD HH24:MI') AS stats_reset
               FROM pg_stat_database WHERE datname = current_database()`)),
          ]);
          const since = reset.rows[0]?.stats_reset || "database creation";
          const section = (title, rows) => `${title}\n${rows.length ? formatTable(rows) : "(none)"}`;
          return { content: [{ type: "text", text: [
            section(`Unused indexes (no scans since ${since}; excludes unique and constraint indexes; counts are per server, check replicas too):`, unused.rows),
            section("Duplicate indexes (same columns, operator classes, expressions and predicate):", duplicate.rows),
            section("Invalid indexes (e.g. failed CREATE INDEX CONCURRENTLY):", invalid.rows),
          ].join("\n\n") }] };
        }
        case "active_queries": {
          const limit = clampInt(args.limit, 50, 100);
          // noinspection SqlNoDataSourceInspection
          // query_id: to_jsonb() avoids a hard reference to the column, which only exists from PostgreSQL 14.
          const [res, waits, access] = await Promise.all([
            dbPool.query(perfSql(
              `SELECT a.pid, a.usename AS user_name, a.datname AS database, left(a.application_name, 30) AS application, a.state,
                      date_trunc('second', now() - a.xact_start)::text AS xact_age,
                      date_trunc('second', now() - a.query_start)::text AS query_age,
                      coalesce(a.wait_event_type || ':' || a.wait_event, '') AS wait,
                      array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by,
                      to_jsonb(a) ->> 'query_id' AS query_id,
                      left(regexp_replace(a.query, '\\s+', ' ', 'g'), 300) AS query
               FROM pg_stat_activity a
               WHERE a.backend_type = 'client backend' AND a.state IS NOT NULL AND a.state <> 'idle'
                 AND a.pid <> pg_backend_pid()
                 AND coalesce(greatest(now() - a.xact_start, now() - a.query_start), interval '0') >= make_interval(secs => $1)
                 AND ($2::text IS NULL OR a.usename = $2::text)
               ORDER BY cardinality(pg_blocking_pids(a.pid)) > 0 DESC, coalesce(a.xact_start, a.query_start)
               LIMIT $3`), [Math.max(0, Number(args.min_duration_seconds) || 0), args.username || null, limit]),
            dbPool.query(perfSql(
              `SELECT coalesce(a.wait_event_type || ':' || a.wait_event, 'CPU (no wait event)') AS wait, count(*) AS sessions
               FROM pg_stat_activity a
               WHERE a.backend_type = 'client backend' AND a.state = 'active' AND a.pid <> pg_backend_pid()
               GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`)),
            // Without pg_read_all_stats, other roles' sessions have state = NULL and are filtered out above.
            dbPool.query(perfSql("SELECT pg_has_role('pg_read_all_stats', 'USAGE') AS all_stats")),
          ]);
          const visibility = access.rows[0]?.all_stats ? ""
            : "\nNote: only sessions of your own role are visible — GRANT pg_read_all_stats (or pg_monitor) TO <user>; see docs/performance.md.";
          if (!res.rows.length) return { content: [{ type: "text", text: `No active sessions matching the filter.${visibility}` }] };
          const count = (pred) => res.rows.filter(pred).length;
          const summary = `Sessions: ${res.rows.length}${res.rows.length === limit ? " (limit reached)" : ""} — `
            + `${count(r => r.state === "active")} active, ${count(r => r.state?.startsWith("idle in transaction"))} idle in transaction, `
            + `${count(r => r.blocked_by)} blocked`;
          const waitText = waits.rows.length ? formatTable(waits.rows) : "(none)";
          return { content: [{ type: "text", text:
            `${summary}\n${formatTable(res.rows)}${visibility}\n\nWait events of active sessions (snapshot):\n${waitText}` }] };
        }
        case "performance_overview": {
          // noinspection SqlNoDataSourceInspection
          const [stats, settings] = await Promise.all([
            dbPool.query(perfSql(
              `SELECT d.datname AS database, pg_size_pretty(pg_database_size(d.datname)) AS size,
                      round(100.0 * d.blks_hit / nullif(d.blks_hit + d.blks_read, 0), 2) AS cache_hit_pct,
                      round(100.0 * d.xact_commit / nullif(d.xact_commit + d.xact_rollback, 0), 2) AS commit_pct,
                      d.numbackends AS db_connections,
                      (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS server_connections,
                      current_setting('max_connections') AS max_connections,
                      d.temp_files, pg_size_pretty(d.temp_bytes) AS temp_size, d.deadlocks, d.conflicts,
                      to_char(d.stats_reset, 'YYYY-MM-DD HH24:MI') AS stats_reset
               FROM pg_stat_database d WHERE d.datname = current_database()`)),
            dbPool.query(perfSql(
              `SELECT name, current_setting(name) AS value, source
               FROM pg_settings WHERE name = ANY($1::text[]) ORDER BY name`), [TUNING_SETTINGS]),
          ]);
          const r = stats.rows[0] || {};
          return { content: [{ type: "text", text:
            `Database statistics (since ${r.stats_reset || "database creation"}):\n${formatRecord(r)}\n\nTuning settings:\n${formatTable(settings.rows)}` }] };
        }
        default:
          // noinspection ExceptionCaughtLocallyJS
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err?.message || err?.toString() || JSON.stringify(err);
      log("error", "MCP", `token="${tokenName}" action="${name}" ip="${clientIp}" error=${JSON.stringify(msg)}`);
      const hint = PERF_TOOL_NAMES.has(name) && PRIVILEGE_ERROR.test(msg) ? PRIVILEGE_HINT : "";
      return { content: [{ type: "text", text: `❌ Error: ${msg}${hint}` }], isError: true };
    }
  });

  return server;
}

/** Text for one result cell. json/jsonb values (e.g. EXPLAIN (FORMAT JSON)) arrive as
 *  objects from pg and would otherwise render as "[object Object]". */
function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) return JSON.stringify(value);
  return String(value);
}

/** Rows as a " | "-separated text table, truncated to `max` rows with a row-count note. */
function formatTable(rows, max = 200) {
  const cols = Object.keys(rows[0]);
  const header = cols.join(" | ");
  const lines = rows.slice(0, max).map(r => cols.map(c => formatCell(r[c])).join(" | "));
  const note = rows.length > max ? `\n(showing ${max} of ${rows.length} rows)` : `\n(${rows.length} row${rows.length !== 1 ? "s" : ""})`;
  return `${header}\n${"─".repeat(Math.min(header.length, 120))}\n${lines.join("\n")}${note}`;
}

/** One row as aligned "key : value" lines. */
function formatRecord(row) {
  const width = Math.max(...Object.keys(row).map(k => k.length));
  return Object.entries(row).map(([k, v]) => `${k.padEnd(width)} : ${formatCell(v)}`).join("\n");
}

/** Note for statistics views that hide other roles' query text. */
function privilegeNote(rows) {
  return rows.some(r => r.query === "<insufficient privilege>")
    ? "\nNote: query text of other roles is hidden — GRANT pg_read_all_stats (or pg_monitor) TO <user>; see docs/performance.md."
    : "";
}

/** table_stats detail view: table statistics with warnings, indexes and per-column planner statistics. */
async function tableDetail(dbPool, schema, table) {
  // noinspection SqlNoDataSourceInspection
  const t = await dbPool.query(perfSql(
    `SELECT c.oid, n.nspname || '.' || c.relname AS table_name,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
            pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
            pg_size_pretty(pg_indexes_size(c.oid)) AS index_size,
            pg_size_pretty(coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)) AS toast_size,
            c.reltuples::bigint AS estimated_rows, s.n_live_tup AS live_rows, s.n_dead_tup AS dead_rows,
            round(100.0 * s.n_dead_tup / nullif(s.n_live_tup + s.n_dead_tup, 0), 1) AS dead_pct,
            s.n_mod_since_analyze AS modified_since_analyze,
            round(current_setting('autovacuum_analyze_threshold')::numeric
                  + current_setting('autovacuum_analyze_scale_factor')::numeric * greatest(c.reltuples, 0)::numeric) AS autoanalyze_threshold,
            s.seq_scan, s.seq_tup_read, s.idx_scan,
            to_char(s.last_vacuum, 'YYYY-MM-DD HH24:MI') AS last_vacuum,
            to_char(s.last_autovacuum, 'YYYY-MM-DD HH24:MI') AS last_autovacuum,
            to_char(s.last_analyze, 'YYYY-MM-DD HH24:MI') AS last_analyze,
            to_char(s.last_autoanalyze, 'YYYY-MM-DD HH24:MI') AS last_autoanalyze,
            array_to_string(c.reloptions, ', ') AS options
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'm')`), [schema, table]
  );
  if (!t.rows.length) return `Table "${schema}.${table}" not found.`;
  const { oid, ...info } = t.rows[0];
  // noinspection SqlNoDataSourceInspection
  const [indexes, columns] = await Promise.all([
    dbPool.query(perfSql(
      `SELECT ic.relname AS index_name, pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
              s.idx_scan, s.idx_tup_read, s.idx_tup_fetch,
              CASE WHEN i.indisprimary THEN 'primary' WHEN i.indisunique THEN 'unique' ELSE '' END AS kind,
              CASE WHEN i.indisvalid THEN '' ELSE 'INVALID' END AS status,
              regexp_replace(pg_get_indexdef(i.indexrelid), '^.* USING ', 'USING ') AS definition
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
       WHERE i.indrelid = $1::oid
       ORDER BY ic.relname`), [oid]),
    dbPool.query(perfSql(
      `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type,
              round(s.null_frac::numeric, 3) AS null_frac, s.n_distinct, s.avg_width,
              round(s.correlation::numeric, 3) AS correlation,
              CASE WHEN s.histogram_bounds IS NOT NULL THEN 'yes' ELSE '' END AS histogram,
              nullif(a.attstattarget, -1) AS stats_target,
              left(s.most_common_vals::text, 60) AS most_common_vals
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = c.relname
                           AND s.attname = a.attname AND s.inherited = (c.relkind = 'p')
       WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`), [oid]),
  ]);

  const warnings = [];
  if (!info.last_analyze && !info.last_autoanalyze) {
    warnings.push("Never analyzed — the planner works with default estimates. Run ANALYZE.");
  } else if (Number(info.modified_since_analyze) > Number(info.autoanalyze_threshold)) {
    warnings.push(`Statistics are probably stale: ${info.modified_since_analyze} rows modified since the last analyze `
      + `(autoanalyze threshold ≈ ${info.autoanalyze_threshold}). Run ANALYZE or check autovacuum.`);
  }
  if (Number(info.dead_pct) >= 20) warnings.push(`${info.dead_pct}% dead rows — check autovacuum and long-running transactions.`);
  for (const ix of indexes.rows) if (ix.status) warnings.push(`Index ${ix.index_name} is invalid — drop and recreate it.`);

  return [
    `Table: ${info.table_name}`,
    formatRecord(info),
    warnings.length ? `\nWarnings:\n${warnings.map(w => `- ${w}`).join("\n")}` : "",
    `\nIndexes:\n${indexes.rows.length ? formatTable(indexes.rows) : "(none)"}`,
    `\nColumn statistics (n_distinct < 0: fraction of rows, -1 = unique; correlation: physical vs. logical order):\n${formatTable(columns.rows)}`,
  ].filter(Boolean).join("\n");
}

/** Integer tool argument within 1..max, `def` when missing or invalid. */
function clampInt(value, def, max) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

/** Tool params for the log line. SQL text is only included at debug level;
 *  otherwise it is replaced by its length so statements with literals don't leak into logs. */
function formatToolParams(args) {
  if (!args || !Object.keys(args).length) return "";
  if (isLogEnabled("debug") || typeof args.sql !== "string") return " params=" + JSON.stringify(args);
  return " params=" + JSON.stringify({ ...args, sql: `<${args.sql.length} chars, LOG_LEVEL=debug to show>` });
}

// ── Session store (stateful HTTP sessions) ────────────────────────────────────
export const sessions = new Map(); // sessionId → StreamableHTTPServerTransport

// ── Request handler (shared by both HTTP and HTTPS) ───────────────────────────
export async function handleRequest(req, res) {
  try {
    await _handleRequest(req, res);
  } catch (err) {
    log("error", "HTTP", `Unhandled error for ${req.method} ${req.url}: ${err.message}`);
    if (err.stack) log("error", "HTTP", err.stack);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}

async function _handleRequest(req, res) {
  if ((req.url === "/admin" || req.url === "/admin/") && req.method === "GET") {
    if (cachedAdminHtml) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(cachedAdminHtml);
    } else {
      res.writeHead(404);
      res.end("Admin UI not found");
    }
    return;
  }
  if (req.url === "/health" && req.method === "GET") {
    const tlsEnabled = (process.env.TLS_ENABLED || "false").toLowerCase() !== "false";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", tls: tlsEnabled }));
    return;
  }
  if (req.url === "/info" && req.method === "GET") {
    if (!checkAdminAuth(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      name: mcpServerName,
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
    await handleAdminRequest(req, res, {
      onDelete: (token) => closePool(token.connection, token.name),
    });
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
      const dbPool = getPool(auth.connection, auth.name);
      const clientIp = getClientIp(req);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          const startedAt = Date.now();
          log("info", "SESSION", `token="${auth.name}" action="start" session="${id}" ip="${clientIp}"`);
          // Chain instead of overwrite: server.connect() already installed its own onclose
          const prevOnClose = transport.onclose;
          transport.onclose = () => {
            sessions.delete(id);
            const duration = Math.round((Date.now() - startedAt) / 1000);
            log("info", "SESSION", `token="${auth.name}" action="stop" session="${id}" ip="${clientIp}" duration=${duration}s`);
            prevOnClose?.();
          };
        },
      });
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
    log("error", "FATAL", `Unhandled rejection: ${msg}`);
    if (reason instanceof Error && reason.stack) log("error", "FATAL", reason.stack);
  });
  process.on("uncaughtException", (err) => {
    log("error", "FATAL", `Uncaught exception: ${err.message}`);
    if (err.stack) log("error", "FATAL", err.stack);
    process.exit(1);
  });
}

// ── Transport selection (only when run directly) ──────────────────────────────
if (isMain) {
  migrateTokenStore();

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
        console.error(`  Auth         : ${authInfo}`);
        console.error(`  Log level    : ${getLogLevel()}`);
      });
    } else {
      // ── HTTP ───────────────────────────────────────────────────────────────
      http.createServer(handleRequest).listen(PORT, () => {
        console.error(`PostgreSQL MCP Server (HTTP) listening on port ${PORT}`);
        console.error(`  MCP endpoint : http://localhost:${PORT}/mcp`);
        console.error(`  Admin UI     : http://localhost:${PORT}/admin`);
        console.error(`  Admin API    : http://localhost:${PORT}/admin/tokens`);
        console.error(`  Health check : http://localhost:${PORT}/health`);
        console.error(`  Auth         : ${authInfo}`);
        console.error(`  Log level    : ${getLogLevel()}`);
      });
    }
  } else {
    // ── stdio ─────────────────────────────────────────────────────────────────
    const server    = createMcpServer(getPool(null, "stdio"), "stdio");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("PostgreSQL MCP Server running on stdio");
  }
}
