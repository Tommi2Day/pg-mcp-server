---
name: pg-top-sessions
description: Lists the top PostgreSQL sessions with the pg-mcp-server tools - longest running statements and transactions, idle-in-transaction sessions, blockers, and sessions grouped by user, application and client host, compared with max_connections. Use when asked who is connected, which sessions use the database, or which client causes load.
---

# Top sessions

Show who is using the database and which sessions matter. Use the tools of the PostgreSQL MCP server
(pg-mcp-server; in some clients the names carry a prefix such as `mcp__postgresql__`).

**Read-only.** Never cancel or terminate sessions on your own. If a session should go, propose
`SELECT pg_cancel_backend(<pid>)` (cancels the statement) or `SELECT pg_terminate_backend(<pid>)` (ends the
session, rolls back its transaction) and let the user decide. An `idle in transaction` session runs no statement, so `pg_cancel_backend` has no effect on it - only
`pg_terminate_backend` ends its transaction.

Input (optional): a role name to filter by.

## Steps

1. **Running sessions**: `active_queries` (with `username` if given). Blocked sessions come first;
   `blocked_by` names the blockers.
2. **Who is connected**: run with `query`:

   ```sql
   SELECT usename AS user_name, coalesce(nullif(application_name, ''), '-') AS application,
          coalesce(host(client_addr), 'local') AS client, state,
          count(*) AS sessions,
          max(now() - xact_start)   AS oldest_xact,
          max(now() - state_change) AS longest_in_state
   FROM pg_stat_activity
   WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
   GROUP BY 1, 2, 3, 4
   ORDER BY sessions DESC, oldest_xact DESC NULLS LAST
   LIMIT 25
   ```

3. **Longest transactions** (these block vacuum and often hold locks):

   ```sql
   SELECT pid, usename AS user_name, application_name, state,
          now() - xact_start   AS xact_age,
          now() - query_start  AS query_age,
          now() - state_change AS in_state,
          wait_event_type, wait_event,
          left(regexp_replace(query, '\s+', ' ', 'g'), 150) AS last_query
   FROM pg_stat_activity
   WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid() AND backend_type = 'client backend'
   ORDER BY xact_start
   LIMIT 15
   ```

4. **Connection limits**:

   ```sql
   SELECT count(*) FILTER (WHERE backend_type = 'client backend') AS client_sessions,
          current_setting('max_connections')::int                 AS max_connections,
          current_setting('superuser_reserved_connections')::int  AS reserved_superuser,
          (SELECT string_agg(rolname || '=' || rolconnlimit, ', ') FROM pg_roles
             WHERE rolconnlimit >= 0 AND rolcanlogin)             AS role_limits
   FROM pg_stat_activity
   ```

5. If a session's statement looks expensive, look it up in `top_queries` with `sql_text_like` (a table name
   from the statement) or by its `query_id`.

Sessions of pg-mcp-server itself have `application_name = <server name>:<token name>`; name the token when
they show up. Without `pg_monitor` only the own role's sessions are fully visible; say so if the tools
report it.

## Report

- A table of the top sessions (pid, user, application, state, xact age, wait, short query), at most ~10 rows
- Grouped view: which users/applications/hosts hold most connections, and the usage of `max_connections`
- Findings: blockers, idle-in-transaction sessions older than a few minutes, transactions open for hours,
  one application holding a disproportionate share of connections - each with a suggested action
  (fix in the application, `idle_in_transaction_session_timeout`, a connection pooler, or cancel/terminate
  after confirmation)
