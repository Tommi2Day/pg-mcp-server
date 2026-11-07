---
name: pg-top-sql
description: Finds and explains the most expensive SQL statements of a PostgreSQL database from pg_stat_statements with the pg-mcp-server tools - by total time, mean time, calls, disk reads and temp usage - and picks the statements worth tuning. Use when asked for top SQL, the slowest or heaviest queries, or what causes database load.
---

# Top SQL

Find the statements that cost the most and say why. Use the tools of the PostgreSQL MCP server
(pg-mcp-server; in some clients the names carry a prefix such as `mcp__postgresql__`).

**Read-only.** Never reset statistics (`pg_stat_statements_reset()`) or create indexes on your own. Do not suggest
a new index without checking the existing ones (`table_stats` with `table`) - or point to the SQL tuning skill.

Input (optional): a sort key (`total_time`, `mean_time`, `calls`, `rows`, `blocks_read`, `temp_written`)
and/or a text filter (table or column name; constants are normalised to `$1`, `$2`, …).

## Steps

1. `top_queries` with the requested `order_by` (default `total_time`), `sql_text_like` if given, `limit: 10`.
   If pg_stat_statements is missing, relay the setup hint from the tool and stop.
2. Unless the user asked for one sort key, also run `order_by: "mean_time"` and `order_by: "calls"`
   (`limit: 5` each) - the heaviest statements overall, the slowest per call and the most frequent are often
   different statements.
3. If disk or temp usage looks relevant (low `hit_pct`, `temp_blks_written` > 0), add `order_by:
   "blocks_read"` or `"temp_written"`.
4. Check the time window: the header shows the statistics reset time. A few days of data are representative;
   minutes are not.
5. For the top candidates, optionally check whether they are running now: `active_queries` (`query_id`
   matches `queryid`).

## Interpreting

| Pattern | Meaning |
|---------|---------|
| High `pct_total`, low `mean_ms`, huge `calls` | Cheap statement executed too often: N+1 queries, missing caching, chatty ORM |
| High `mean_ms` | Slow per call: plan problem, missing index, too much data - a tuning candidate |
| `rows / calls` large | Returns or touches many rows: missing filter, pagination, or reporting query on OLTP |
| `hit_pct` < 95 | Reads from disk: large scans or working set larger than memory |
| `temp_blks_written` > 0 | Sort/hash spills to disk: `work_mem` too small for it, or a missing index for ORDER BY |
| `<insufficient privilege>` | The user lacks `pg_monitor`; say so once |

## Report

- A compact table of the top statements: queryid, calls, total and mean time, pct of total, rows/call,
  hit %, temp blocks, shortened SQL
- For the 3 most relevant statements: what they do, why they are expensive (pattern from the table above)
  and the recommended next step
- Offer to tune a statement with the SQL tuning skill (pass the queryid or SQL text), and note the time
  window the numbers cover
