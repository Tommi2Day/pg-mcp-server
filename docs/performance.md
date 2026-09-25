# Performance analysis

pg-mcp-server includes six read-only tools for SQL tuning and performance diagnosis. They use only views and
functions that ship with PostgreSQL, plus the `pg_stat_statements` extension for `top_queries`.

- [Tools](#tools)
- [Required privileges](#required-privileges)
- [Setting up pg_stat_statements](#setting-up-pg_stat_statements)
- [Tool reference](#tool-reference)
- [Typical workflows](#typical-workflows)
- [Settings that matter](#settings-that-matter)
- [Safety](#safety)
- [Troubleshooting](#troubleshooting)

---

## Tools

| Tool | Purpose | Main sources |
|------|---------|--------------|
| `explain_query` | Execution plan of one statement, optionally executed (`ANALYZE`) or with unbound placeholders (`GENERIC_PLAN`) | `EXPLAIN` |
| `top_queries` | Most expensive statements of the current database | `pg_stat_statements`, `pg_stat_statements_info` |
| `table_stats` | Overview of many tables, or details of one table incl. planner statistics | `pg_stat_user_tables`, `pg_stats`, `pg_index` |
| `index_health` | Unused, duplicate and invalid indexes | `pg_stat_user_indexes`, `pg_index` |
| `active_queries` | Running / idle-in-transaction sessions, blockers, wait events | `pg_stat_activity`, `pg_blocking_pids()` |
| `performance_overview` | Cache hit ratio, connections, temp files, deadlocks, key settings | `pg_stat_database`, `pg_settings` |

All tools return plain text tables. None of them changes data or settings.

---

## Required privileges

The simplest setup is the predefined role **`pg_monitor`**, which contains `pg_read_all_stats`,
`pg_read_all_settings` and `pg_stat_scan_tables`:

```sql
GRANT pg_monitor TO mcp_user;
```

Without it the tools still work, but show less:

| Tool | Without `pg_monitor` / `pg_read_all_stats` |
|------|--------------------------------------------|
| `top_queries` | Statements of other roles show `<insufficient privilege>` instead of the text and no `queryid`; the tool adds a note |
| `active_queries` | Only sessions of the own role are visible (PostgreSQL hides the state of other sessions); the tool adds a note |
| `table_stats` (detail) | Column statistics only for columns the user may `SELECT` (`pg_stats` filters by privilege) |
| `performance_overview` | A few settings (e.g. `shared_preload_libraries`) may be hidden without `pg_read_all_settings` |
| `explain_query` | Needs the normal privileges on the tables in the statement |
| `index_health` | No restrictions — catalog data is public |

Errors such as `permission denied …` from a performance tool get a hint pointing here.
Role membership takes effect for new sessions; restart the server (its connection pool) after granting.

---

## Setting up pg_stat_statements

`top_queries` needs the extension in the database the token connects to:

```ini
# postgresql.conf (server restart required)
shared_preload_libraries = 'pg_stat_statements'
compute_query_id = on            # default "auto" also works once the extension is loaded
pg_stat_statements.track = top   # "all" also records statements inside functions
```

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- in every database you want to analyse
```

Docker example:

```bash
docker run -d postgres:18 -c shared_preload_libraries=pg_stat_statements
```

Managed services (RDS, Cloud SQL, Azure) usually preload the extension already; only `CREATE EXTENSION` is needed.
If the extension is missing, `top_queries` explains how to enable it instead of failing.

---

## Tool reference

### explain_query

| Parameter | Default | Description |
|-----------|---------|-------------|
| `sql` | required | One statement, without `EXPLAIN` (a trailing `;` is removed) |
| `params` | – | Values for `$1`, `$2`, … |
| `analyze` | `false` | Execute the statement and report actual times and rows |
| `buffers` | = `analyze` | Buffer usage (shared hit/read, temp) |
| `verbose` | `false` | Output columns, schema-qualified names |
| `settings` | `false` | Planner-relevant settings that differ from the defaults (PostgreSQL 12+) |
| `generic_plan` | `false` | Plan with unbound placeholders (PostgreSQL 16+); not together with `analyze` or `params` |
| `format` | `text` | `text` or `json` |

The statement always runs inside `BEGIN READ ONLY` and is **always rolled back**, so `analyze: true` on a
`SELECT` has no lasting effect and on `INSERT`/`UPDATE`/`DELETE` fails with
`cannot execute … in a read-only transaction`. Only a single statement is accepted.

`generic_plan` is useful for statements copied from `top_queries`, whose constants are replaced by `$1`, `$2`, …:
the plan is the one a prepared statement would use without knowing the values.

```text
Index Scan using t_v2 on t  (cost=0.29..8.30 rows=1 width=41)
  Index Cond: (v = $2)
  Filter: (id = $1)
```

### top_queries

| Parameter | Default | Description |
|-----------|---------|-------------|
| `order_by` | `total_time` | `total_time`, `mean_time`, `calls`, `rows`, `blocks_read`, `temp_written` |
| `sql_text_like` | – | Case-insensitive text filter. Constants are normalised to `$n`, so search for table or column names |
| `user` | – | Only statements executed by this role |
| `limit` | 10 | max. 100 |

Values are cumulative since the last reset (`pg_stat_statements_reset()`), shown in the header on PostgreSQL 14+.
`pct_total` is the share of the database's total execution time, `hit_pct` the shared buffer hit ratio.
`queryid` matches `query_id` in `active_queries`. If entries were evicted because `pg_stat_statements.max` is too
small, the tool says so. Statements issued by the performance tools themselves are excluded.

```text
Top statements by total_time since 2026-09-25 19:47:
queryid | user_name | calls | total_ms | mean_ms | pct_total | rows | hit_pct | shared_blks_read | temp_blks_written | query
6786301278288751876 | postgres | 1 | 29.7 | 29.66 | 22.3 | 3000 | 99.5 | 146 | 0 | UPDATE t SET n = n + $1 WHERE id <= $2
```

### table_stats

| Parameter | Default | Description |
|-----------|---------|-------------|
| `table` | – | Omitted: overview of many tables. Given: detail view of this table |
| `schema` | all user schemas / `public` | Schema filter (overview) or schema of `table` (detail) |
| `order_by` | `size` | Overview only: `size`, `seq_scan`, `seq_tup_read`, `dead_rows` |
| `limit` | 20 | Overview only, max. 200 |

The **overview** shows sizes, live/dead rows, sequential vs. index scans and the last vacuum/analyze per table.
Many `seq_scan` with a high `seq_tup_read` on a large table is the classic sign of a missing index.

The **detail view** shows:

- sizes (table, indexes, TOAST), estimated vs. live rows, dead rows, rows modified since the last analyze and the
  approximate autoanalyze threshold, scan counters, vacuum/analyze times, per-table storage options
- **warnings**: never analyzed, statistics probably stale (more rows modified than the autoanalyze threshold),
  ≥ 20 % dead rows, invalid indexes
- all indexes with definition, size, scans, tuples read/fetched, primary/unique, invalid
- per-column planner statistics from `pg_stats`: `null_frac`, `n_distinct` (negative = fraction of rows,
  `-1` = unique), `avg_width`, `correlation` (1/-1 = physical order follows the column, good for range scans),
  whether a histogram exists, a column-specific statistics target, the most common values

```text
Warnings:
- Statistics are probably stale: 3000 rows modified since the last analyze (autoanalyze threshold ≈ 1050). Run ANALYZE or check autovacuum.
- 23.1% dead rows — check autovacuum and long-running transactions.
```

The threshold uses the server-wide `autovacuum_analyze_threshold` / `autovacuum_analyze_scale_factor`;
per-table overrides are listed under `options`.

### index_health

| Parameter | Default | Description |
|-----------|---------|-------------|
| `schema` | all user schemas | Schema filter |

- **Unused**: `idx_scan = 0` since the statistics reset; unique, primary-key and constraint indexes are excluded.
  Counters are per server — an index unused on the primary may serve queries on a replica.
- **Duplicate**: same table, columns, operator classes, collations, expressions and predicate.
- **Invalid**: typically left behind by a failed `CREATE INDEX CONCURRENTLY`; drop and recreate.

### active_queries

| Parameter | Default | Description |
|-----------|---------|-------------|
| `min_duration_seconds` | 0 | Only sessions whose statement or transaction runs at least this long |
| `username` | – | Only sessions of this role |
| `limit` | 50 | max. 100 |

Client sessions that are not idle, **blocked sessions first**. `blocked_by` lists the PIDs holding the lock,
`query_id` (PostgreSQL 14+, needs `compute_query_id`) links to `top_queries`. The header counts active,
idle-in-transaction and blocked sessions; a second table groups all active sessions by wait event
(`CPU (no wait event)` = running or not instrumented). The server's own sessions carry
`application_name = <MCP_SERVER_NAME>:<token name>`, e.g. `pg-mcp-server:reporting-team`, so you can see which
token a session belongs to.

```text
Sessions: 2 — 1 active, 1 idle in transaction, 1 blocked
pid | user_name | database | application | state | xact_age | query_age | wait | blocked_by | query_id | query
113 | postgres | postgres | psql | active | 00:00:41 | 00:00:41 | Lock:relation | 114 | | SELECT count(*) FROM t
114 | postgres | postgres | psql | idle in transaction | 00:01:10 | 00:01:10 | Client:ClientRead | | 3563466410410026429 | LOCK t
```

### performance_overview

No parameters. Database statistics since the last reset — size, cache hit ratio (should be > 99 % for OLTP),
commit ratio, connections vs. `max_connections`, temp files, deadlocks, replication conflicts — and the values and
sources of 20 key settings (`shared_buffers`, `work_mem`, `effective_cache_size`, `random_page_cost`, autovacuum,
checkpoints, parallelism, `jit`, `track_io_timing`, …).

---

## Typical workflows

**A statement is slow**
1. `top_queries` (`order_by: "mean_time"`, or `sql_text_like` with a table name) → statement text and `queryid`
2. `explain_query` with `generic_plan: true` on the normalised text, or with real `params` and `analyze: true`
   to compare estimated vs. actual rows
3. `table_stats` with `table` for tables with bad estimates: stale statistics, skewed `n_distinct`, missing
   histograms, low correlation for range scans
4. `explain_query` again for a rewritten statement; create indexes via `execute`

**Something is blocking**
- `active_queries` → blocked sessions first, `blocked_by` names the PIDs; the blocker is often
  `idle in transaction`

**The database feels slow in general**
- `performance_overview` (cache hit ratio, temp files, connections), `top_queries` by `total_time`,
  `table_stats` ordered by `seq_tup_read` or `dead_rows`, `index_health` for write overhead of unused indexes

---

## Settings that matter

| Setting | Relevance |
|---------|-----------|
| `shared_preload_libraries` | Must contain `pg_stat_statements` for `top_queries` |
| `compute_query_id` | `on`/`auto` fills `query_id` in `pg_stat_activity` (PostgreSQL 14+) |
| `pg_stat_statements.max` | Number of tracked statements (default 5000); raise if `top_queries` reports evictions |
| `track_io_timing` | Adds I/O times to `EXPLAIN (ANALYZE, BUFFERS)` and `pg_stat_statements`; low overhead on modern hardware |
| `auto_explain` | Logs plans of slow statements automatically (`auto_explain.log_min_duration`) — PostgreSQL keeps no plan cache that could be queried afterwards |
| `default_statistics_target` | Detail of column statistics; raise per column (`ALTER TABLE … ALTER COLUMN … SET STATISTICS`) for skewed data |

---

## Safety

- All tools are read-only. `explain_query` runs in `BEGIN READ ONLY` and always ends with `ROLLBACK`.
- `explain_query` and `query` accept exactly **one** statement (extended query protocol), so
  `SELECT 1; COMMIT; DROP …` is rejected before anything runs. `generic_plan` must use the simple protocol because
  placeholders stay unbound; the statement is first parsed via the extended protocol, which fails for multiple
  statements, and only then run.
- Sort keys and `EXPLAIN` options come from fixed lists; filter values are passed as query parameters.
- The SQL text of tool calls is only logged at `LOG_LEVEL=debug`.

---

## Troubleshooting

| Message | Cause / fix |
|---------|-------------|
| `pg_stat_statements is not installed in this database` | See [Setting up pg_stat_statements](#setting-up-pg_stat_statements) |
| `pg_stat_statements must be loaded via "shared_preload_libraries"` | Extension created but library not preloaded — add it and restart PostgreSQL |
| `<insufficient privilege>` in `top_queries`, or only own sessions in `active_queries` | `GRANT pg_monitor TO <user>`, then restart the MCP server |
| `unrecognized EXPLAIN option "generic_plan"` | Server older than PostgreSQL 16 — pass `params` instead |
| `generic_plan cannot be combined with analyze or params` | A generic plan is never executed; use one or the other |
| `cannot insert multiple commands into a prepared statement` | More than one statement in `sql` — send one per call |
| `cannot execute INSERT in a read-only transaction` | `analyze: true` on a data-modifying statement is not allowed |
| Unused index still needed | Counters are per server and reset with `pg_stat_reset()`; check replicas and the reset time in the header |
