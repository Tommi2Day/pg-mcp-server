---
name: pg-activity
description: Answers "what is my PostgreSQL database doing right now?" with the pg-mcp-server tools - current load, running and waiting sessions, the most expensive SQL, and health flags (blocking, long transactions, connection saturation, cache misses, temp files, deadlocks, transaction ID wraparound). Use for a quick health check or when the database "feels slow".
---

# What is my database doing?

Give a short, evidence-based picture of the current state of the database. Use the tools of the
PostgreSQL MCP server (pg-mcp-server; in some clients the names carry a prefix such as `mcp__postgresql__`).

**Read-only.** Never call `execute`, `pg_cancel_backend()`, `pg_terminate_backend()` or change settings
on your own. Propose such actions with the exact statement and let the user decide. Do not suggest a new index
without checking the existing ones (`table_stats` with `table`) - or point to the SQL tuning skill instead.

## Steps

1. **Overview**: `performance_overview` - cache hit ratio, connections vs. `max_connections`, temp files,
   deadlocks, conflicts, key settings. Note the statistics reset time: values are cumulative since then.
2. **Sessions now**: `active_queries` (default arguments). Note the counts of active, idle-in-transaction
   and blocked sessions and the wait event summary.
3. **Load by SQL**: `top_queries` with `order_by: "total_time"`, `limit: 10`. If pg_stat_statements is
   missing, say so once (the tool explains the setup) and continue without it.
4. **Health flags**: run with `query`:

   ```sql
   SELECT
     (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend')            AS client_sessions,
     current_setting('max_connections')::int                                                   AS max_connections,
     (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction'
        AND now() - state_change > interval '5 minutes')                                       AS idle_in_xact_over_5min,
     (SELECT max(now() - xact_start) FROM pg_stat_activity
        WHERE backend_type = 'client backend' AND pid <> pg_backend_pid())                     AS oldest_xact,
     (SELECT max(age(datfrozenxid)) FROM pg_database)                                          AS max_xid_age,
     current_setting('autovacuum_freeze_max_age')::bigint                                      AS freeze_max_age,
     (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker')          AS autovacuum_workers,
     (SELECT count(*) FROM pg_replication_slots WHERE NOT active)                              AS inactive_slots
   ```

   If a line fails for lack of privileges, drop it and continue; mention the missing `pg_monitor` role once.
5. **Optional, when something stands out**: repeat `active_queries` two or three times a few seconds apart
   to tell a lasting problem from a spike, and use `table_stats` (`order_by: "seq_tup_read"` or
   `"dead_rows"`) when sequential scans or bloat are suspected.

## Interpreting

| Signal | Rule of thumb |
|--------|---------------|
| Cache hit ratio | < 99 % on OLTP: working set larger than `shared_buffers` / OS cache, or large scans |
| Connections | > 80 % of `max_connections`: risk of `too many connections`; consider a pooler |
| Idle in transaction | Holds locks and blocks vacuum; usually an application not committing |
| Oldest transaction | Minutes to hours: blocks vacuum (bloat) and may hold locks |
| `max_xid_age` | > 50 % of `autovacuum_freeze_max_age`: watch; > 100 %: anti-wraparound vacuum running or overdue |
| Temp files growing | Sorts/hashes spill to disk: check `work_mem` and the statements with `temp_written` |
| Deadlocks > 0 | Inconsistent lock order in the application; see the server log for the statements |
| Inactive replication slots | Retain WAL and can fill the disk |
| Wait events | `Lock:*` blocking, `LWLock:*` internal contention, `IO:*` disk reads, `Client:ClientRead` waiting for the app, none = CPU |

## Report

Start with a one-line verdict (e.g. "Healthy, moderate load" or "2 sessions blocked by an idle transaction").
Then list findings, most severe first, each with the evidence (numbers from the tools) and a concrete next
step. Mention the related skill when a deeper look makes sense: top sessions, top SQL, locks and waits,
SQL tuning. Keep it short; no raw tool output beyond what supports a finding.
