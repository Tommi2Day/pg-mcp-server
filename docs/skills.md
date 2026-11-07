# Skills: guided database workflows

pg-mcp-server ships seven guided workflows for typical DBA questions. They combine the
[MCP tools](../README.md#available-mcp-tools) — mostly the [performance tools](performance.md) — into a fixed procedure
with catalog queries, interpretation rules and a report format, so the answer is the same quality every time.

Each workflow is one file, `skills/<name>/SKILL.md`, and is available in two ways:

- **MCP prompts** — built into the server (`prompts/list`, `prompts/get`). Every MCP client can use them, no
  installation needed.
- **Agent Skills** — the same files in the [Agent Skills](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview)
  format for Claude Code, Claude Desktop and claude.ai. Claude loads a skill automatically when the question matches.

- [Workflows](#workflows)
- [Prerequisites](#prerequisites)
- [Using the MCP prompts](#using-the-mcp-prompts)
- [Installing the Agent Skills](#installing-the-agent-skills)
- [Safety](#safety)
- [Adding a workflow](#adding-a-workflow)

---

## Workflows

| Skill / prompt | Question it answers | Prompt arguments | Main tools |
|----------------|---------------------|------------------|------------|
| `pg-activity` | What is my database doing right now? Load, sessions, top SQL, health flags (blocking, long transactions, connections, wraparound) | – | `performance_overview`, `active_queries`, `top_queries`, `query` |
| `pg-top-sessions` | Who is connected, which sessions run longest, which application holds the connections? | `username` | `active_queries`, `query` |
| `pg-top-sql` | Which statements cost the most — by total time, per call, frequency, disk reads, temp usage? | `order_by`, `filter` | `top_queries`, `active_queries` |
| `pg-locks-waits` | Why do sessions hang? Blocking chains, root blockers, lock types, dominant wait events, deadlocks | – | `active_queries`, `query` (`pg_locks`, `pg_blocking_pids`), `performance_overview` |
| `pg-sql-tuning` | Why is this statement slow and what fixes it? Plan analysis, statistics, index and rewrite proposals, verified with a new plan | `sql` or `queryid` | `explain_query`, `table_stats`, `index_health`, `describe_table` |
| `pg-document` | Markdown documentation of a schema: tables, columns, comments, constraints, Mermaid ER diagram, indexes, views, functions, triggers, enums | `schema` | `query` (catalog), `list_schemas`, `test_connection` |
| `pg-error-analysis` | What does this error mean, why does it happen here, how is it fixed? SQLSTATE classification with evidence from the database | `error` (required), `statement` | depends on the error class |

The catalog queries in the skills are tested on PostgreSQL 13 and 17.

---

## Prerequisites

The workflows use the performance tools, so the same privileges apply (see
[Required privileges](performance.md#required-privileges)):

```sql
GRANT pg_monitor TO mcp_user;                       -- all sessions and statement texts visible
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- for top SQL and tuning
```

Without them the workflows still run, but see only the own role's sessions and skip the top-SQL steps; the
report says so.

---

## Using the MCP prompts

The server announces the `prompts` capability. How a client shows prompts differs:

| Client | How to start a workflow |
|--------|-------------------------|
| Claude Code | Slash command `/mcp__<server>__<prompt>`, e.g. `/mcp__postgresql__pg-activity` or `/mcp__postgresql__pg-sql-tuning "SELECT …"` (arguments in order) |
| Claude Desktop | **+** button → **Add from &lt;server&gt;** → pick the prompt, fill in the arguments |
| VS Code (Copilot) | Chat: `/mcp.<server>.<prompt>` |
| Other clients | `prompts/list` and `prompts/get` per the MCP specification |

`<server>` is the name of the server entry in the client configuration (`postgresql` in the [examples](../README.md#mcp-client-configuration)).

`prompts/get` returns the workflow text as a user message; supplied arguments are appended as an `## Input` section.
Unknown prompts or a missing required argument are rejected with JSON-RPC error `-32602` (invalid params).
Each `prompts/get` is logged as `action="get_prompt" params={"name":"…"}` — the argument values are not logged
(see [Logging](logging.md)).

---

## Installing the Agent Skills

Agent Skills are loaded by Claude on demand: only the name and description are always in context, the full
workflow is read when a question matches ("what is my database doing?", "why is this query slow?"). The MCP server
must still be connected — the skills call its tools.

**Claude Code** — copy the folders into your personal or project skills directory:

```bash
git clone --depth 1 https://github.com/Tommi2Day/pg-mcp-server.git /tmp/pg-mcp-server
cp -r /tmp/pg-mcp-server/skills/pg-* ~/.claude/skills/          # personal, all projects
# or: cp -r /tmp/pg-mcp-server/skills/pg-* .claude/skills/      # this project only (commit to share)
```

**Claude Desktop / claude.ai** — each skill is uploaded as a ZIP file containing its folder
(**Settings → Capabilities → Skills → Upload skill**):

```bash
cd /tmp/pg-mcp-server/skills
for s in pg-*; do (zip -qr "../$s.zip" "$s"); done   # one ZIP per skill in /tmp/pg-mcp-server
```

When a client has both the prompts and the skills, either works — the content is identical.

---

## Safety

All workflows are **read-only by instruction**: they gather evidence with `query`, `explain_query` and the other
read-only tools and *propose* changes. They tell the model not to run, without the user's confirmation:

- `execute` (DDL such as `CREATE INDEX`, `ANALYZE`, data changes),
- `pg_cancel_backend()` / `pg_terminate_backend()` — these functions also work inside the read-only
  transaction of `query`,
- setting changes or `pg_stat_statements_reset()`.

`pg-sql-tuning` starts with plans that do not execute the statement; `analyze: true` runs it (always rolled back) and
is only used when the plan alone does not explain the problem.

This is guidance for the model, not an access control. To make writes impossible, give the token a database role
without write privileges — see [Per-token connection](../README.md#authentication).

---

## Adding a workflow

1. Create `skills/<name>/SKILL.md` with frontmatter `name` (= folder name, lowercase letters, digits, hyphens) and
   `description` (what it does and when to use it, max. 1024 characters, one line), followed by the workflow.
2. Optional prompt arguments: add an entry to `PROMPT_ARGUMENTS` in `src/prompts.js`.
3. `npm test` checks that every shipped skill parses and matches its folder name.

The server reads the skills once at startup; restart it after changes.
