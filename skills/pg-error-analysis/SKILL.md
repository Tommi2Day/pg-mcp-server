---
name: pg-error-analysis
description: Analyses a PostgreSQL error message or SQLSTATE with the pg-mcp-server tools - classifies it, explains the cause in plain words, collects evidence from the database (sessions, locks, settings, privileges, objects, statistics) and gives a concrete fix. Use when an application or query fails with a PostgreSQL error, e.g. deadlock, serialization failure, timeout, too many connections, permission denied, duplicate key, or out of memory.
---

# Error analysis

Explain why an error happens and how to fix it, backed by evidence from the database. Use the tools of the
PostgreSQL MCP server (pg-mcp-server; in some clients the names carry a prefix such as `mcp__postgresql__`).

**Read-only.** Gather evidence with read-only tools. Propose fixes (SQL, settings, application changes) and run
them with `execute` only after the user confirms.

Input: the error message, ideally with SQLSTATE, the failing statement and when it happens (always, under load,
sporadically). Ask for missing parts only if the error cannot be classified without them.

## Steps

1. **Classify** by SQLSTATE (first two characters = class) or message, using the table below.
2. **Collect evidence** for that class:
   - Objects named in the message: `describe_table`, `list_tables`; for functions/types query `pg_proc` / `pg_type`.
   - Privileges: `SELECT current_user, has_table_privilege('<table>', 'SELECT'), has_schema_privilege('<schema>', 'USAGE')`
     (with the role from the error if different: `has_table_privilege('<role>', '<table>', 'INSERT')`).
   - Locks, timeouts, deadlocks, connections: `active_queries`, `performance_overview` (deadlocks, conflicts,
     connections, temp files) and the related settings from `pg_settings`.
   - Constraint violations: the constraint definition (`pg_get_constraintdef`). Reading the conflicting row means
     reading table data: do it only when the user agrees, otherwise give the query for the user to run.
   - Resource errors: `performance_overview`, `table_stats`, database size (`pg_database_size(current_database())`).
3. **Server log** (optional, often needs extra privileges): `SELECT pg_current_logfile()` shows where the log is.
   Reading it (`pg_read_file`) needs superuser or `pg_read_server_files`; if that fails, tell the user which log
   lines to look for (e.g. `DETAIL`/`CONTEXT` of the deadlock report) instead.
4. **Reproduce safely** if useful: `explain_query` (never `analyze` for data-modifying statements) or a read-only
   `query`.

## Common errors

| SQLSTATE | Error | Usual cause | Fix direction |
|----------|-------|-------------|---------------|
| 23505 | duplicate key value violates unique constraint | Concurrent inserts, sequence behind the data after a manual load | `INSERT … ON CONFLICT`; `setval()` the sequence to `max(id)` |
| 23503 | violates foreign key constraint | Parent row missing or deleted, wrong load order | Load order, `ON DELETE` behaviour, deferrable constraints |
| 23502 / 23514 | not-null / check violation | Application sends incomplete data | Fix input or default |
| 40001 | could not serialize access | `REPEATABLE READ`/`SERIALIZABLE` conflict - expected behaviour | Retry the transaction in the application |
| 40P01 | deadlock detected | Two transactions lock rows/tables in different order | Consistent order, shorter transactions; server log shows both statements |
| 55P03 | lock not available / `lock_timeout` | Another session holds the lock | Find the blocker (`active_queries`), retry, run DDL off-peak |
| 57014 | canceling statement due to statement timeout / user request | `statement_timeout`, client cancel, or a recovery conflict on a replica | Tune the statement, raise the timeout for this role/job only |
| 25P02 | current transaction is aborted | An earlier statement in the transaction failed; the real error is before this one | Look for the first error; rollback/savepoint handling in the app |
| 25P03 | idle-in-transaction timeout | Session idle in a transaction longer than `idle_in_transaction_session_timeout` | Commit earlier in the application |
| 53300 | too many connections | `max_connections` or role/database connection limit reached | Connection pooler, fix leaks, check `active_queries` / grouped sessions |
| 53200 | out of memory | Large `work_mem` × parallel nodes × sessions, huge result or hash | Lower `work_mem` per query, fewer connections, check the plan |
| 53100 | could not extend file / no space left | Disk full: data, WAL (inactive replication slots, archiving failures) or temp files | Free space, check slots and archiver, temp-heavy statements |
| 54000 | program limit exceeded (e.g. index row size) | Value too large for a B-tree index entry | Hash index or index on `md5(col)` |
| 42P01 / 42703 / 42883 | relation / column / function does not exist | Wrong schema or `search_path`, case-sensitive quoted name, missing extension or cast | Qualify names, check `search_path`, explicit casts |
| 42501 | permission denied | Missing `GRANT` on table, schema `USAGE`, sequence, or function | Specific `GRANT`, default privileges for new objects |
| 22P02 / 22003 / 22001 | invalid input / out of range / value too long | Type mismatch in application data | Validate input, widen the type |
| 08006 / 08001 / 57P01 | connection failure / admin shutdown | Network, restart, `pg_terminate_backend`, idle timeouts in a proxy or firewall | Reconnect logic, keepalives, check the server log |
| XX000 / XX001 / XX002 | internal error / data corrupted / index corrupted | Bug or storage corruption | Server log, `amcheck`, `REINDEX`; check hardware - escalate |

## Report

1. **What happened** - the error in plain words
2. **Why** - root cause, with the evidence you collected (tool results, settings, definitions)
3. **Fix** - immediate action and lasting fix, as ready-to-run SQL or concrete application change; mark anything that
   needs the user's confirmation
4. **Prevent** - setting, monitoring or code pattern that avoids a repeat (e.g. retry loop for 40001/40P01)
