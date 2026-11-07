import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/lib.js", () => ({ log: vi.fn() }));

import { parseSkill, loadPrompts, buildPromptResult, PROMPT_ARGUMENTS, SKILLS_DIR } from "../src/prompts.js";
import { log } from "../src/lib.js";

// ── parseSkill ────────────────────────────────────────────────────────────────
describe("parseSkill", () => {
  it("splits frontmatter and body", () => {
    const skill = parseSkill("---\nname: my-skill\ndescription: Does things\n---\n\n# Title\n\nBody\n");
    expect(skill).toEqual({ name: "my-skill", description: "Does things", body: "# Title\n\nBody" });
  });

  it("accepts CRLF line endings and quoted values", () => {
    const skill = parseSkill("---\r\nname: \"a-b\"\r\ndescription: 'Quoted: yes'\r\n---\r\nBody");
    expect(skill).toEqual({ name: "a-b", description: "Quoted: yes", body: "Body" });
  });

  it("returns null without frontmatter, name or description", () => {
    expect(parseSkill("# No frontmatter")).toBeNull();
    expect(parseSkill("---\nname: x\n---\nBody")).toBeNull();
    expect(parseSkill("---\ndescription: y\n---\nBody")).toBeNull();
  });
});

// ── loadPrompts ───────────────────────────────────────────────────────────────
describe("loadPrompts", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
    vi.mocked(log).mockClear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeSkill = (name, content) => {
    fs.mkdirSync(path.join(dir, name));
    if (content !== undefined) fs.writeFileSync(path.join(dir, name, "SKILL.md"), content);
  };

  it("loads skills sorted by name, attaches arguments and skips invalid ones with a warning", () => {
    writeSkill("pg-top-sql", "---\nname: pg-top-sql\ndescription: Top SQL\n---\nBody B");
    writeSkill("a-skill", "---\nname: a-skill\ndescription: First\n---\nBody A");
    writeSkill("broken", "no frontmatter");
    writeSkill("empty");
    fs.writeFileSync(path.join(dir, "README.md"), "not a skill dir");

    const prompts = loadPrompts(dir);
    expect(prompts.map(p => p.name)).toEqual(["a-skill", "pg-top-sql"]);
    expect(prompts[0].arguments).toEqual([]);
    expect(prompts[1].arguments).toBe(PROMPT_ARGUMENTS["pg-top-sql"]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("warn", "MCP", expect.stringContaining('skill="broken"'));
  });

  it("returns an empty list when the directory does not exist", () => {
    expect(loadPrompts(path.join(dir, "missing"))).toEqual([]);
  });

  it("the shipped skills are valid Agent Skills (name = directory, description ≤ 1024 chars)", () => {
    const prompts = loadPrompts(SKILLS_DIR);
    expect(prompts.length).toBeGreaterThanOrEqual(7);
    expect(log).not.toHaveBeenCalled();
    for (const p of prompts) {
      expect(fs.existsSync(path.join(SKILLS_DIR, p.name, "SKILL.md"))).toBe(true);
      expect(p.name).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(p.description.length).toBeLessThanOrEqual(1024);
      expect(p.body.length).toBeGreaterThan(200);
    }
    // every configured argument list belongs to a shipped skill
    for (const name of Object.keys(PROMPT_ARGUMENTS)) {
      expect(prompts.map(p => p.name)).toContain(name);
    }
  });
});

// ── buildPromptResult ─────────────────────────────────────────────────────────
describe("buildPromptResult", () => {
  const prompt = {
    name: "p", description: "Desc", body: "Do it.",
    arguments: [{ name: "error", required: true }, { name: "statement", required: false }],
  };

  it("appends supplied arguments as Input section in argument order", () => {
    const result = buildPromptResult(prompt, { statement: "SELECT 1", error: "boom", extra: "ignored" });
    expect(result.description).toBe("Desc");
    expect(result.messages).toEqual([{
      role: "user",
      content: { type: "text", text: "Do it.\n\n## Input\n\n- error: boom\n- statement: SELECT 1" },
    }]);
  });

  it("returns the plain body without arguments", () => {
    const result = buildPromptResult({ ...prompt, arguments: [] });
    expect(result.messages[0].content.text).toBe("Do it.");
  });

  it("throws when a required argument is missing", () => {
    expect(() => buildPromptResult(prompt, { statement: "x" })).toThrow(/Missing required argument\(s\) for prompt p: error/);
  });
});
