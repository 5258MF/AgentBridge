/**
 * Agent Skills: task-specific instructions stored on this machine as <name>/SKILL.md folders.
 *
 * Harnesses such as pi, opencode, and DeepSeek Harness scan fixed skill directories, put only
 * each skill's name and description in front of the model, and load the body when a task
 * matches. An MCP server cannot edit the client's system prompt, so AgentBridge puts the catalog
 * in the load_skill tool description (the one channel every client shows the model) and loads
 * bodies through load_skill. load_skill reads only inside discovered skill folders, so user
 * skills outside the workspace do not open the rest of the disk to read_files.
 *
 * Roots, in priority order (the first skill with a given name wins):
 *   1. <workspace folder>/.agents/skills, for each workspace folder in order
 *   2. ~/.agents/skills
 * Only direct children are skills (<root>/<name>/SKILL.md); nested SKILL.md files are ignored.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { ToolError } from "./tool-errors.js";

export const SKILLS_DIR_SEGMENTS = [".agents", "skills"] as const;
export const SKILL_FILE_NAME = "SKILL.md";
/** Agent Skills spec limits. */
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
/** SKILL.md and supporting files larger than this are not read. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
/** Skills listed in the tool description; the rest are reachable through load_skill without name. */
export const MAX_CATALOG_SKILLS = 100;
/** Folders examined per root, so a huge directory cannot stall tools/list. */
const MAX_DIRS_PER_ROOT = 500;
/** Supporting files listed when a skill is loaded. */
export const MAX_LISTED_SKILL_FILES = 50;
const MAX_LIST_DEPTH = 4;

export const SKILL_CATALOG_PLACEHOLDER = "${RUNTIME_SKILL_CATALOG}";

export type SkillSource = "workspace" | "user";

export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  /** Absolute skill folder. */
  readonly directory: string;
  /** Absolute path of SKILL.md. */
  readonly file: string;
  /** For workspace skills, SKILL.md relative to its workspace folder, with forward slashes. */
  readonly workspacePath?: string;
  /**
   * disable-model-invocation: true. In pi, Claude Code, and DeepSeek Harness such a skill runs
   * only when the user invokes it (/name); the model never picks it on its own. Over MCP the
   * user's /name arrives as chat text, so these skills stay loadable by name but are listed apart,
   * to be loaded only when the user names them.
   */
  readonly onRequestOnly: boolean;
}

export interface SkillDiscoveryOptions {
  readonly workspaceRoots: readonly string[];
  /** The user's home directory; ~/.agents/skills lives under it. Omit to skip user skills. */
  readonly homeDir?: string;
}

export interface SkillDiscoveryResult {
  readonly skills: SkillEntry[];
  /** Skills that were skipped, with the reason, for the output channel. */
  readonly warnings: string[];
}

export const LOAD_SKILL_TOOL = {
  name: "load_skill",
  description: [
    "Load an Agent Skill: task-specific instructions kept in a SKILL.md file on this machine.",
    "",
    "- When the task matches a skill listed below, load it before starting and follow its instructions.",
    "- When the user names a skill, for example /deploy, $deploy, or \"use the deploy skill\", load that skill first.",
    "- Returns the SKILL.md instructions, the skill directory, and the other files in it. Relative paths in a skill are relative to that directory.",
    "- Pass file to read another text file of the skill, such as a reference document; run its scripts with run_command.",
    "- Omit name to list the skills again, including ones added after this list was sent.",
    "- Skills come from .agents/skills in each workspace folder and from ~/.agents/skills; a workspace skill wins over a user skill with the same name.",
    "",
    SKILL_CATALOG_PLACEHOLDER,
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: MAX_SKILL_NAME_LENGTH,
        description: "Skill name from the list. Omit to list all skills.",
      },
      file: {
        type: "string",
        minLength: 1,
        description: "Optional path of another file inside the skill, relative to the skill directory, e.g. references/api.md. Requires name.",
      },
    },
    additionalProperties: false,
  },
} as const;

export interface LoadSkillInput {
  readonly name?: string;
  readonly file?: string;
}

export function parseLoadSkillInput(value: unknown): LoadSkillInput {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ToolError("INVALID_ARGUMENT", "expected an object.");
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (key !== "name" && key !== "file") throw new ToolError("INVALID_ARGUMENT", `unknown argument ${key}.`);
  }
  if (row.name !== undefined && (typeof row.name !== "string" || !row.name.trim())) {
    throw new ToolError("INVALID_ARGUMENT", "name must be a non-empty string when provided.");
  }
  if (row.file !== undefined && (typeof row.file !== "string" || !row.file.trim())) {
    throw new ToolError("INVALID_ARGUMENT", "file must be a non-empty string when provided.");
  }
  if (row.file !== undefined && row.name === undefined) {
    throw new ToolError("INVALID_ARGUMENT", "file requires name.", "Pass the skill name together with file.");
  }
  return { name: (row.name as string | undefined)?.trim(), file: (row.file as string | undefined)?.trim() };
}

// ---------------------------------------------------------------------------------------------
// Frontmatter

/**
 * Parse the YAML frontmatter of a SKILL.md. Only top-level scalar keys are read (name,
 * description, disable-model-invocation, ...): plain, single- or double-quoted, block (| or >),
 * and plain values continued on indented lines. Nested mappings are skipped. Returns undefined
 * when the file has no frontmatter.
 */
export function parseSkillFrontmatter(text: string): { fields: Record<string, string>; body: string } | undefined {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return undefined;
  const fields: Record<string, string> = {};
  let index = 1;
  while (index < end) {
    const line = lines[index];
    const match = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(line);
    index += 1;
    if (!match) continue;
    const key = match[1];
    const raw = (match[2] ?? "").replace(/\s+#.*$/, "").trim();
    const continuation: string[] = [];
    while (index < end && (lines[index].trim() === "" || /^\s/.test(lines[index]))) {
      continuation.push(lines[index]);
      index += 1;
    }
    while (continuation.length && continuation[continuation.length - 1].trim() === "") continuation.pop();

    const block = /^([|>])([+-]?)\d*$/.exec(raw);
    if (block) {
      const indent = Math.min(...continuation.filter((item) => item.trim()).map((item) => item.length - item.trimStart().length));
      const content = continuation.map((item) => item.slice(Number.isFinite(indent) ? indent : 0));
      fields[key] = block[1] === "|" ? content.join("\n") : foldLines(content);
      continue;
    }
    if (raw.startsWith("\"")) {
      const joined = [raw, ...continuation.map((item) => item.trim())].join(" ");
      const closing = findClosingDoubleQuote(joined);
      fields[key] = unescapeDoubleQuoted(joined.slice(1, closing < 0 ? undefined : closing));
      continue;
    }
    if (raw.startsWith("'")) {
      const joined = [raw, ...continuation.map((item) => item.trim())].join(" ");
      let closing = -1;
      for (let at = 1; at < joined.length; at += 1) {
        if (joined[at] !== "'") continue;
        if (joined[at + 1] === "'") at += 1;
        else { closing = at; break; }
      }
      fields[key] = joined.slice(1, closing < 0 ? undefined : closing).replace(/''/g, "'");
      continue;
    }
    if (raw === "") {
      // Either a nested mapping or list (skipped) or a plain scalar on the following lines.
      const first = continuation.find((item) => item.trim());
      if (first && !/^\s*(- |[\w-]+\s*:)/.test(first)) fields[key] = foldLines(continuation.map((item) => item.trim()));
      continue;
    }
    fields[key] = [raw, ...continuation.map((item) => item.trim()).filter(Boolean)].join(" ");
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

function foldLines(lines: readonly string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) paragraphs.push(current.join(" "));
      current = [];
    } else {
      current.push(line.trim());
    }
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

function findClosingDoubleQuote(text: string): number {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "\"") return index;
  }
  return -1;
}

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char));
}

function isTrue(value: string | undefined): boolean {
  return value !== undefined && /^(true|yes|on|1)$/i.test(value.trim());
}

// ---------------------------------------------------------------------------------------------
// Discovery

export function skillRoots(options: SkillDiscoveryOptions): Array<{ root: string; source: SkillSource; workspaceRoot?: string }> {
  const roots: Array<{ root: string; source: SkillSource; workspaceRoot?: string }> = options.workspaceRoots
    .map((workspaceRoot) => ({ root: path.join(workspaceRoot, ...SKILLS_DIR_SEGMENTS), source: "workspace" as const, workspaceRoot }));
  if (options.homeDir) roots.push({ root: path.join(options.homeDir, ...SKILLS_DIR_SEGMENTS), source: "user" });
  return roots;
}

/** Scan the skill roots. Never throws: unreadable roots and invalid skills become warnings. */
export async function discoverSkills(options: SkillDiscoveryOptions): Promise<SkillDiscoveryResult> {
  const skills: SkillEntry[] = [];
  const warnings: string[] = [];
  const byName = new Map<string, SkillEntry>();
  const seenFiles = new Set<string>();

  for (const { root, source, workspaceRoot } of skillRoots(options)) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") warnings.push(`${root}: ${(error as Error).message}`);
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries.slice(0, MAX_DIRS_PER_ROOT)) {
      if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      const directory = path.join(root, entry.name);
      const file = path.join(directory, SKILL_FILE_NAME);
      let text: string;
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_SKILL_FILE_BYTES) {
          warnings.push(`${file}: skipped, larger than ${MAX_SKILL_FILE_BYTES / 1024} KB`);
          continue;
        }
        const real = await fsp.realpath(file);
        if (seenFiles.has(real)) continue;
        seenFiles.add(real);
        text = await fsp.readFile(file, "utf8");
      } catch {
        continue; // A folder without SKILL.md is not a skill.
      }
      const parsed = parseSkillFrontmatter(text);
      if (!parsed) {
        warnings.push(`${file}: skipped, no YAML frontmatter with name and description`);
        continue;
      }
      const name = (parsed.fields.name ?? entry.name).trim();
      if (!name || name.length > MAX_SKILL_NAME_LENGTH || /[\s/\\]/.test(name)) {
        warnings.push(`${file}: skipped, invalid name "${name}"`);
        continue;
      }
      const description = (parsed.fields.description ?? "").replace(/\s+/g, " ").trim();
      if (!description) {
        warnings.push(`${file}: skipped, description is required`);
        continue;
      }
      const existing = byName.get(name);
      if (existing) {
        warnings.push(`${file}: skipped, skill "${name}" is already provided by ${existing.file}`);
        continue;
      }
      const skill: SkillEntry = {
        name,
        description: description.length > MAX_SKILL_DESCRIPTION_LENGTH ? `${description.slice(0, MAX_SKILL_DESCRIPTION_LENGTH - 1)}…` : description,
        source,
        directory,
        file,
        workspacePath: workspaceRoot ? path.relative(workspaceRoot, file).split(path.sep).join("/") : undefined,
        onRequestOnly: isTrue(parsed.fields["disable-model-invocation"]),
      };
      byName.set(name, skill);
      skills.push(skill);
    }
  }
  return { skills, warnings };
}

// ---------------------------------------------------------------------------------------------
// Model-facing text

/** The catalog that replaces SKILL_CATALOG_PLACEHOLDER in the load_skill description. */
export function formatSkillCatalog(skills: readonly SkillEntry[]): string {
  if (!skills.length) {
    return "No skills are installed. A skill is a folder with a SKILL.md in .agents/skills of a workspace folder or in ~/.agents/skills.";
  }
  const shown = skills.slice(0, MAX_CATALOG_SKILLS);
  const automatic = shown.filter((skill) => !skill.onRequestOnly);
  const onRequest = shown.filter((skill) => skill.onRequestOnly);
  const lines: string[] = [];
  if (automatic.length) lines.push("Available skills:", ...automatic.map((skill) => `- ${skill.name}: ${skill.description}`));
  if (onRequest.length) {
    if (lines.length) lines.push("");
    lines.push("Load these only when the user names them, never on your own:", ...onRequest.map((skill) => `- ${skill.name}: ${skill.description}`));
  }
  if (skills.length > shown.length) lines.push(`- ... ${skills.length - shown.length} more; call load_skill without name to list them.`);
  return lines.join("\n");
}

export function renderLoadSkillDescription(skills: readonly SkillEntry[]): string {
  return LOAD_SKILL_TOOL.description.replace(SKILL_CATALOG_PLACEHOLDER, formatSkillCatalog(skills));
}

export interface LoadSkillResult {
  readonly text: string;
  readonly structuredContent: Record<string, unknown>;
}

/** Run load_skill. Throws ToolError on failure. */
export async function loadSkill(input: LoadSkillInput, context: SkillDiscoveryOptions): Promise<LoadSkillResult> {
  const { skills } = await discoverSkills(context);

  if (!input.name) {
    const lines = [`skills: ${skills.length}`];
    for (const skill of skills) {
      lines.push(`- ${skill.name} (${skill.source}${skill.onRequestOnly ? ", only when the user names it" : ""}): ${skill.description}`, `  location: ${skill.file}`);
    }
    if (!skills.length) lines.push(formatSkillCatalog(skills));
    return {
      text: lines.join("\n"),
      structuredContent: { skills: skills.map((skill) => ({ name: skill.name, description: skill.description, source: skill.source, location: skill.file, onRequestOnly: skill.onRequestOnly })) },
    };
  }

  const skill = skills.find((candidate) => candidate.name === input.name)
    ?? skills.find((candidate) => candidate.name.toLowerCase() === input.name!.toLowerCase());
  if (!skill) {
    throw new ToolError(
      "SKILL_NOT_FOUND",
      `No skill named ${input.name}.`,
      skills.length ? `Available skills: ${skills.map((candidate) => candidate.name).join(", ")}.` : "No skills are installed; continue without one.",
    );
  }

  if (input.file) return readSkillFile(skill, input.file);

  const parsed = parseSkillFrontmatter(await fsp.readFile(skill.file, "utf8"));
  const body = (parsed?.body ?? "").trim();
  const { files, truncated } = await listSkillFiles(skill.directory);
  const lines = [
    `skill: ${skill.name}`,
    `source: ${skill.source}`,
    `directory: ${skill.directory}`,
    "Relative paths in this skill are relative to directory. Read its files with load_skill name and file; run its scripts with run_command.",
    `files: ${files.length ? files.join(", ") : "(none)"}${truncated ? " (list truncated)" : ""}`,
    "--- CONTENT BEGIN ---",
    body,
    "--- CONTENT END ---",
  ];
  return {
    text: lines.join("\n"),
    structuredContent: { name: skill.name, source: skill.source, directory: skill.directory, location: skill.file, workspacePath: skill.workspacePath, files, filesTruncated: truncated },
  };
}

async function readSkillFile(skill: SkillEntry, requested: string): Promise<LoadSkillResult> {
  const normalized = requested.replace(/\\/g, "/");
  const target = path.resolve(skill.directory, normalized);
  const outside = (candidate: string, base: string) => {
    const relative = path.relative(base, candidate);
    return relative === "" || relative.startsWith("..") || path.isAbsolute(relative);
  };
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || outside(target, skill.directory)) {
    throw new ToolError("PATH_OUTSIDE_SKILL", `${requested} is not inside the ${skill.name} skill directory.`, "Pass a path relative to the skill directory, as listed in files.");
  }
  let stat: import("node:fs").Stats;
  let real: string;
  try {
    real = await fsp.realpath(target);
    stat = await fsp.stat(real);
  } catch {
    throw new ToolError("FILE_NOT_FOUND", `${requested} does not exist in the ${skill.name} skill.`, "Load the skill without file to see its files.");
  }
  if (outside(real, await fsp.realpath(skill.directory))) {
    throw new ToolError("PATH_OUTSIDE_SKILL", `${requested} resolves outside the ${skill.name} skill directory.`);
  }
  if (!stat.isFile()) throw new ToolError("NOT_A_FILE", `${requested} is not a file.`);
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    throw new ToolError("FILE_TOO_LARGE", `${requested} is ${Math.ceil(stat.size / 1024)} KB; load_skill reads files up to ${MAX_SKILL_FILE_BYTES / 1024} KB.`, "Read a part of it with run_command instead.");
  }
  const bytes = await fsp.readFile(real);
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new ToolError("BINARY_FILE", `${requested} is a binary file.`, "Use it through run_command, for example by running it as a script.");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new ToolError("UNSUPPORTED_ENCODING", `${requested} is not valid UTF-8.`);
  }
  const relative = path.relative(skill.directory, target).split(path.sep).join("/");
  return {
    text: [`skill: ${skill.name}`, `file: ${relative}`, `path: ${target}`, "--- CONTENT BEGIN ---", content.replace(/\r\n/g, "\n").replace(/\n$/, ""), "--- CONTENT END ---"].join("\n"),
    structuredContent: { name: skill.name, source: skill.source, file: relative, path: target, sizeBytes: stat.size },
  };
}

/** Files of a skill other than SKILL.md, relative, sorted, skipping hidden entries and node_modules. */
export async function listSkillFiles(directory: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_LIST_DEPTH) await walk(path.join(dir, entry.name), relative, depth + 1);
        else truncated = true;
      } else if (relative !== SKILL_FILE_NAME) {
        if (files.length >= MAX_LISTED_SKILL_FILES) {
          truncated = true;
          return;
        }
        files.push(relative);
      }
    }
  }
  await walk(directory, "", 1);
  return { files, truncated };
}
