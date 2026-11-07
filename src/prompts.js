/**
 * MCP prompts built from the Agent Skills in skills/<name>/SKILL.md.
 * The SKILL.md files are the single source: Claude clients can install them as skills, every MCP client
 * gets them as prompts. No MCP SDK imports (testable like lib.js).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./lib.js";

export const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

/** Prompt arguments per skill. SKILL.md frontmatter only carries name and description (Agent Skills format). */
export const PROMPT_ARGUMENTS = {
  "pg-top-sessions": [
    { name: "username", description: "Only sessions of this role", required: false },
  ],
  "pg-top-sql": [
    { name: "order_by", description: "total_time, mean_time, calls, rows, blocks_read or temp_written", required: false },
    { name: "filter", description: "Only statements containing this text, e.g. a table name", required: false },
  ],
  "pg-sql-tuning": [
    { name: "sql", description: "SQL statement to tune", required: false },
    { name: "queryid", description: "queryid from top_queries (instead of sql)", required: false },
  ],
  "pg-document": [
    { name: "schema", description: "Schema to document (default: all user schemas)", required: false },
  ],
  "pg-error-analysis": [
    { name: "error", description: "Error message, ideally with SQLSTATE", required: true },
    { name: "statement", description: "The failing SQL statement", required: false },
  ],
};

/**
 * Splits a SKILL.md into its frontmatter fields (single-line `key: value`, optionally quoted) and the body.
 * Returns null when the file has no frontmatter with name and description.
 */
export function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!fields.name || !fields.description) return null;
  return { name: fields.name, description: fields.description, body: match[2].trim() };
}

/** Reads all skills/<name>/SKILL.md files; skips (and logs) files that cannot be read or parsed. */
export function loadPrompts(dir = SKILLS_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const prompts = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const file = path.join(dir, entry.name, "SKILL.md");
    let skill = null;
    try {
      skill = parseSkill(fs.readFileSync(file, "utf8"));
    } catch { /* missing or unreadable — reported below */ }
    if (!skill) {
      log("warn", "MCP", `skill="${entry.name}" error="no SKILL.md with name and description"`);
      continue;
    }
    prompts.push({ ...skill, arguments: PROMPT_ARGUMENTS[skill.name] ?? [] });
  }
  return prompts.sort((a, b) => a.name.localeCompare(b.name));
}

/** prompts/get result: the skill body plus the supplied arguments as an "Input" section. */
export function buildPromptResult(prompt, args = {}) {
  const missing = prompt.arguments.filter((a) => a.required && !args[a.name]);
  if (missing.length) {
    throw new Error(`Missing required argument(s) for prompt ${prompt.name}: ${missing.map((a) => a.name).join(", ")}`);
  }
  const input = prompt.arguments
    .filter((a) => args[a.name])
    .map((a) => `- ${a.name}: ${args[a.name]}`);
  const text = input.length ? `${prompt.body}\n\n## Input\n\n${input.join("\n")}` : prompt.body;
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}
