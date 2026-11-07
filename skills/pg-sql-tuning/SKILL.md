---
name: pg-sql-tuning
description: Tunes a slow PostgreSQL SQL statement with the pg-mcp-server tools - reads the execution plan, compares estimated and actual rows, checks table and column statistics and indexes, and proposes index changes or query rewrites that are verified with a new plan. Use when a query is slow, for a queryid from top SQL, or when asked to optimise or explain a query plan.
---

# SQL tuning

Make one statement faster and prove it with a plan. Use the tools of the PostgreSQL MCP server
(pg-mcp-server; in some clients the names carry a prefix such as `mcp__postgresql__`).

**Safety.** `explain_query` runs in a read-only transaction that is always rolled back. With `analyze: true` the
statement really executes - a statement that runs for minutes also runs for minutes in EXPLAIN ANALYZE, so
start without it. Never create, drop or change indexes, statistics or settings yourself: propose the DDL and run
it with `execute` only after the user confirms. Prefer `CREATE INDEX CONCURRENTLY` on busy tables.

Input: the SQL text, or a `queryid` from `top_queries`. Without either, run `top_queries` with
`order_by: "mean_time"` and ask which statement to tune.

## Steps

1. **Get the statement.** For a queryid: `top_queries` with `sql_text_like` (a distinctive part of the statement)
   or a larger `limit`, and match the queryid. Note calls, mean time and rows per call.
2. **Plan without executing**: `explain_query`. Statements from `top_queries` contain `$1`, `$2`, …:
   use `generic_plan: true` (PostgreSQL 16+), or ask for realistic values and pass them as `params`.
3. **Actual plan** when the estimated plan does not explain the problem and the statement is a `SELECT` that
   finishes in reasonable time: `explain_query` with `analyze: true` (buffers are included) and real `params`.
4. **Tables in the plan**: `table_stats` with `table` for each large table involved - stale statistics, dead rows,
   existing indexes and their usage, column statistics (`n_distinct`, `correlation`, most common values).
   `describe_table` for column types and constraints when relevant.
5. **Hypothesis and fix.** Propose one change at a time (see the checklist). If the `hypopg` extension is
   installed (`SELECT * FROM pg_extension WHERE extname = 'hypopg'`), a hypothetical index can be tested without
   building it - ask before using it.
6. **Verify**: `explain_query` on the rewritten statement, or after the user created the index. Compare cost,
   or with `analyze` the actual time and buffers, before vs. after.

## Plan checklist

| Plan symptom | Likely cause | Fix to consider |
|--------------|--------------|-----------------|
| Estimated vs. actual rows off by 10x or more | Stale or too coarse statistics, correlated columns | `ANALYZE`, `ALTER TABLE … ALTER COLUMN … SET STATISTICS`, `CREATE STATISTICS` (dependencies/ndistinct/mcv) |
| `Seq Scan` on a large table with a selective filter (`Rows Removed by Filter` high) | Missing or unusable index | Index on the filter columns; equality columns first, then range |
| Index not used although it exists | Function or cast on the column (`lower(col)`, `col::text`), type mismatch, leading wildcard `LIKE '%x'` | Rewrite the predicate, expression index, `pg_trgm` index for wildcards |
| `Nested Loop` with large `loops` on the inner side | Row underestimate on the outer side | Fix statistics; index on the inner join key |
| `Sort` / `Hash` with `external merge` or `Batches` > 1 | Spills to disk | Index matching `ORDER BY`, smaller result, `work_mem` for this query (`SET LOCAL`) |
| `Index Only Scan` with many `Heap Fetches` | Visibility map out of date | `VACUUM`; check autovacuum |
| Large `OFFSET` | Rows read and thrown away | Keyset pagination (`WHERE id > $last ORDER BY id LIMIT n`) |
| `NOT IN (subquery)` | Cannot become an anti-join; NULL semantics | `NOT EXISTS` |
| `OR` across different columns | One index cannot serve it | `UNION ALL` of two indexed queries, or a BitmapOr with two indexes |
| `SELECT *` on wide rows, many rows returned | Too much data transferred | Select needed columns; covering index (`INCLUDE`) |
| CTE scanned many times / `Materialize` | Forced materialisation | `NOT MATERIALIZED` or inline the CTE |

An index costs write performance and space: check `index_health` for unused or duplicate indexes on the
same table before adding one, and prefer extending an existing index.

## Report

1. The statement (shortened) and why it is slow, pointing at the plan node(s) responsible
2. The recommended change(s) as ready-to-run SQL, each with expected effect and cost (index size, write overhead,
   lock during creation)
3. Before/after comparison once verified
4. Anything you could not verify (e.g. analyze skipped because the statement modifies data)
