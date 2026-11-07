---
name: pg-document
description: Documents a PostgreSQL database or schema with the pg-mcp-server tools - tables with columns, types, defaults, constraints and comments, primary and foreign keys as a Mermaid ER diagram, indexes, views, functions, triggers, enums, sizes and row counts - as a Markdown document. Use when asked to document, describe or give an overview of a database, schema or data model.
---

# Document a database

Produce accurate Markdown documentation of a schema from the catalog. Use the tools of the PostgreSQL MCP server
(pg-mcp-server; in some clients the names carry a prefix such as `mcp__postgresql__`).

**Read-only.** Only catalog queries; never read table contents beyond what the user asks for, and never add
comments (`COMMENT ON`) without confirmation - offer them as a separate SQL script instead.

Input (optional): the schema to document. Without it, run `list_schemas` and document the user schemas
(not `pg_catalog`, `information_schema`, `pg_toast`); ask first if there are many.

## Steps

All queries below run with `query` and `params: ["<schema>"]`.

1. **Context**: `test_connection` (server version, database).
2. **Tables** with comments, size and estimated rows:

   ```sql
   SELECT c.relname AS table_name, CASE c.relkind WHEN 'p' THEN 'partitioned' ELSE 'table' END AS kind,
          obj_description(c.oid, 'pg_class') AS comment,
          c.reltuples::bigint AS est_rows, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
   FROM pg_class c
   WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
   ORDER BY 1
   ```

3. **Columns** with types, defaults, nullability and comments:

   ```sql
   SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type,
          a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_value,
          col_description(c.oid, a.attnum) AS comment
   FROM pg_attribute a
   JOIN pg_class c ON c.oid = a.attrelid
   LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum
   ```

4. **Constraints** (primary, unique, foreign keys, checks):

   ```sql
   SELECT conrelid::regclass AS table_name, conname, contype,
          confrelid::regclass AS references_table, pg_get_constraintdef(oid) AS definition
   FROM pg_constraint
   WHERE connamespace = $1::regnamespace AND contype IN ('p', 'u', 'f', 'c', 'x')
   ORDER BY 1, contype, conname
   ```

5. **Indexes** (not backing a constraint):

   ```sql
   SELECT i.indrelid::regclass AS table_name, c.relname AS index_name, pg_get_indexdef(i.indexrelid) AS definition
   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relnamespace = $1::regnamespace
     AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
   ORDER BY 1, 2
   ```

6. **Views, functions, triggers, enums**:

   ```sql
   SELECT c.relname AS view_name, CASE c.relkind WHEN 'm' THEN 'materialized' ELSE 'view' END AS kind,
          obj_description(c.oid, 'pg_class') AS comment
   FROM pg_class c WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('v', 'm')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
   ORDER BY 1
   ```

   ```sql
   SELECT p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
          pg_get_function_identity_arguments(p.oid) AS arguments, pg_get_function_result(p.oid) AS returns,
          l.lanname AS language, obj_description(p.oid, 'pg_proc') AS comment
   FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = $1::regnamespace AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
   ORDER BY 1, 3
   ```

   ```sql
   SELECT t.tgrelid::regclass AS table_name, t.tgname AS trigger_name, pg_get_triggerdef(t.oid) AS definition
   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relnamespace = $1::regnamespace AND NOT t.tgisinternal
   ORDER BY 1, 2
   ```

   ```sql
   SELECT t.typname AS enum_name, string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS labels
   FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE t.typnamespace = $1::regnamespace
   GROUP BY 1 ORDER BY 1
   ```

   For a view definition on request: `SELECT pg_get_viewdef('<schema>.<view>'::regclass, true)`.

Objects that belong to an extension (e.g. the `pg_stat_statements` view) are left out; list installed extensions
once: `SELECT extname, extversion FROM pg_extension`.

For large schemas (more than ~40 tables) ask whether to document all tables in full or give an overview plus
details for selected tables. Partitions are covered by their partitioned parent.

## Document structure

```markdown
# <database> / <schema>
Generated <date> from PostgreSQL <version>. Summary: N tables, N views, N functions, total size.

## Entity-relationship diagram
(mermaid erDiagram with tables, their PK/FK columns and the foreign-key relationships)

## Tables
### <table>  — <comment>
est. rows, size
| Column | Type | Null | Default | Comment |
Constraints: PK, unique, FK (→ referenced table), checks
Indexes: name — definition
Triggers

## Views / Functions / Enums
```

In the Mermaid diagram use `||--o{` for a foreign key (referenced table on the left), list only key columns
and a few important ones per table, and leave the diagram out or split it by area above ~30 tables.

Mark missing table or column comments ("no comment") instead of inventing descriptions; you may suggest
descriptions in a separate section, clearly labelled as suggestions. Offer to save the document as a file
and to generate a `COMMENT ON` script for the suggested comments.
