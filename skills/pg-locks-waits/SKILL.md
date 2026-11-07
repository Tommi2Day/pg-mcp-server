---
name: pg-locks-waits
description: Detects problematic situations in a PostgreSQL database with the pg-mcp-server tools - blocking lock chains, lock waits, idle-in-transaction blockers, long transactions holding back vacuum, deadlocks and dominant wait events (Lock, LWLock, IO, Client) - and explains the root cause. Use when sessions hang, queries wait, the application times out, or deadlocks are reported.
---

# Locks and waits

Find what sessions wait for, who blocks them and why. Use the tools of the PostgreSQL MCP server
(pg-mcp-server; in some clients the names carry a prefix such as `mcp__postgresql__`).

**Read-only.** Never cancel or terminate a session on your own. Propose `SELECT pg_cancel_backend(<pid>)`
or `SELECT pg_terminate_backend(<pid>)` for the root blocker and let the user decide. An `idle in transaction` session runs no statement, so `pg_cancel_backend` has no effect on it - only
`pg_terminate_backend` ends its transaction.

## Steps

1. **Snapshot**: `active_queries`. Blocked sessions come first; `blocked_by` names the blocking PIDs. The wait
   event table shows what active sessions wait for.
2. **Blocking chains** (who blocks whom, root blockers have no blocker themselves) with `query`:

   ```sql
   SELECT a.pid, pg_blocking_pids(a.pid) AS blocked_by, a.usename AS user_name, a.application_name,
          a.state, a.wait_event_type, a.wait_event,
          now() - a.xact_start  AS xact_age,
          now() - a.query_start AS query_age,
          left(regexp_replace(a.query, '\s+', ' ', 'g'), 150) AS query
   FROM pg_stat_activity a
   WHERE cardinality(pg_blocking_pids(a.pid)) > 0
      OR a.pid IN (SELECT unnest(pg_blocking_pids(b.pid)) FROM pg_stat_activity b)
   ORDER BY a.xact_start NULLS LAST
   ```

3. **Locks involved** (only when step 2 found blocking):

   ```sql
   SELECT l.pid, l.locktype, l.mode, l.granted,
          CASE WHEN l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
               THEN l.relation::regclass::text END AS relation,
          l.transactionid, l.virtualxid,
          now() - a.xact_start AS xact_age, a.state
   FROM pg_locks l
   JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE NOT l.granted
      OR l.pid IN (SELECT unnest(pg_blocking_pids(w.pid)) FROM pg_locks w WHERE NOT w.granted)
   ORDER BY l.granted, relation, l.pid
   ```

4. **Sampling**: wait events are a point-in-time view. Run `active_queries` two or three more times a few
   seconds apart; a wait seen in every sample is the bottleneck, a single hit is noise.
5. **History and guard rails**: `performance_overview` (deadlocks, conflicts since reset), and with `query`:

   ```sql
   SELECT name, setting, unit, source FROM pg_settings
   WHERE name IN ('deadlock_timeout', 'lock_timeout', 'statement_timeout',
                  'idle_in_transaction_session_timeout', 'log_lock_waits', 'max_locks_per_transaction')
   ```

## Interpreting

| Finding | Typical cause | Typical fix |
|---------|---------------|-------------|
| Root blocker `idle in transaction`, wait `Client:ClientRead` | Application opened a transaction and does not commit (exception path, user think time, debugger) | Fix the application; set `idle_in_transaction_session_timeout` |
| Blocker runs DDL (`ALTER TABLE`, `CREATE INDEX` without `CONCURRENTLY`, `TRUNCATE`, `VACUUM FULL`) | `AccessExclusiveLock` queues all readers behind it, even behind a waiting DDL | Run DDL with `lock_timeout`, use `CONCURRENTLY` variants, off-peak |
| Many `transactionid` waits on the same rows | Hot rows updated by many sessions (counters, queues, status rows) | `SELECT … FOR UPDATE SKIP LOCKED` for queues, shorter transactions, batching |
| Deadlocks > 0 | Sessions lock the same rows/tables in different order | Consistent lock order; the server log shows both statements |
| `LWLock:*` dominant | Internal contention (`BufferMapping`, `WALWrite`, `LockManager` with many partitions/locks) | Depends: fewer connections (pooler), faster WAL disk, fewer partitions touched per query |
| `IO:DataFileRead` dominant | Data not in cache, large scans | Indexes, more memory, check top SQL by `blocks_read` |
| `IO:WALSync` / `WALWrite` | Commit latency limited by WAL disk | Faster disk, group commits, `synchronous_commit` trade-offs (ask first) |
| Long transaction, no blocking | Holds back vacuum (`backend_xmin`) → bloat | End it; review batch jobs and replication slots |

## Report

1. One-line verdict: blocking yes/no, how many sessions waiting, the root blocker(s)
2. The blocking chain as an indented tree: root blocker (pid, user, app, state, xact age, query) → waiting sessions
3. Root cause in plain words and the recommended action; for an immediate fix give the exact
   `pg_cancel_backend` / `pg_terminate_backend` statement and its consequence (rollback of the blocker's work)
4. Preventive settings or application changes
