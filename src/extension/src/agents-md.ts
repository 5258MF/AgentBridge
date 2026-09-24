/**
 * AGENTS.md: standing instructions for agents, loaded automatically like pi, opencode, Codex,
 * and DeepSeek Harness do.
 *
 * Baseline, sent when a session starts (broad to specific):
 *   1. ~/.agents/AGENTS.md (the user's own rules, next to ~/.agents/skills)
 *   2. for each workspace folder, every AGENTS.md from the enclosing git repository root down to
 *      the workspace folder (only the workspace folder itself when it is not inside a repository)
 * Directory files: an AGENTS.md in a subfolder of a workspace folder applies to files under it.
 * Like opencode and DeepSeek Harness, it is sent once per session when read_files or
 * apply_patch first touches a file under that subfolder.
 *
 * An MCP server cannot add to the client's system prompt. The baseline goes into the server
 * instructions and, because some clients never show those to the model, also in front of the
 * session's first tool result. Directory files ride on the tool result that reached them.
 * Reads are synchronous: a handful of small files, and the session instructions are built
 * synchronously.
 */
import fs from "node:fs";
import path from "node:path";

export const AGENTS_FILE_NAME = "AGENTS.md";
/** ~/.agents holds the user's AGENTS.md, as ~/.agents/skills holds the user's skills. */
export const USER_AGENTS_DIR = ".agents";
/** Budget for one rendered block, as in Codex (project_doc_max_bytes). */
export const MAX_AGENTS_MD_BYTES = 32 * 1024;
/** Source files larger than this are skipped outright. */
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_ANCESTOR_LEVELS = 32;

export type AgentsFileScope = "user" | "project" | "directory";

export interface AgentsFile {
  /** Absolute path. */
  readonly path: string;
  readonly content: string;
  readonly scope: AgentsFileScope;
}

export interface AgentsDiscoveryOptions {
  readonly workspaceRoots: readonly string[];
  /** The user's home directory; ~/.agents/AGENTS.md lives under it. Omit to skip it. */
  readonly homeDir?: string;
}

/** Normalized key for "already sent" bookkeeping (case-insensitive on Windows). */
export function agentsFileKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function readAgentsFile(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return undefined;
    const content = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

function exists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories whose AGENTS.md applies to a workspace folder, broad to specific: from the nearest
 * ancestor that contains .git down to the folder. Without a repository, only the folder itself,
 * so an unrelated AGENTS.md higher up the disk is never picked up.
 */
export function projectDirectories(workspaceRoot: string): string[] {
  const root = path.resolve(workspaceRoot);
  const chain = [root];
  if (exists(path.join(root, ".git"))) return chain;
  let current = root;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    chain.unshift(parent);
    if (exists(path.join(parent, ".git"))) return chain;
    current = parent;
  }
  return [root];
}

/** The baseline files for a new session, broad to specific, without duplicates. */
export function discoverAgentsFiles(options: AgentsDiscoveryOptions): AgentsFile[] {
  const files: AgentsFile[] = [];
  const seen = new Set<string>();
  const add = (file: string, scope: AgentsFileScope) => {
    const key = agentsFileKey(file);
    if (seen.has(key)) return;
    const content = readAgentsFile(file);
    if (content === undefined) return;
    seen.add(key);
    files.push({ path: path.resolve(file), content, scope });
  };
  if (options.homeDir) add(path.join(options.homeDir, USER_AGENTS_DIR, AGENTS_FILE_NAME), "user");
  for (const root of options.workspaceRoots) {
    for (const dir of projectDirectories(root)) add(path.join(dir, AGENTS_FILE_NAME), "project");
  }
  return files;
}

function isStrictlyInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * AGENTS.md files in subfolders of a workspace folder that apply to the given files and are not
 * in `sent` yet, broad to specific. Paths may be absolute or relative to a workspace folder; a
 * relative path is resolved against the first folder where its parent directory exists.
 */
export function directoryAgentsFiles(touched: readonly string[], workspaceRoots: readonly string[], sent: ReadonlySet<string>): AgentsFile[] {
  const files: AgentsFile[] = [];
  const seen = new Set<string>();
  const roots = workspaceRoots.map((root) => path.resolve(root));
  for (const raw of touched) {
    if (!raw) continue;
    let absolute: string | undefined;
    let root: string | undefined;
    if (path.isAbsolute(raw)) {
      absolute = path.resolve(raw);
      root = roots.find((candidate) => isStrictlyInside(candidate, absolute!));
    } else {
      for (const candidate of roots) {
        const resolved = path.resolve(candidate, raw);
        if (isStrictlyInside(candidate, resolved) && exists(path.dirname(resolved))) {
          absolute = resolved;
          root = candidate;
          break;
        }
      }
    }
    if (!absolute || !root) continue;
    const chain: string[] = [];
    for (let dir = path.dirname(absolute); isStrictlyInside(root, dir); dir = path.dirname(dir)) chain.unshift(dir);
    for (const dir of chain) {
      const file = path.join(dir, AGENTS_FILE_NAME);
      const key = agentsFileKey(file);
      if (sent.has(key) || seen.has(key)) continue;
      seen.add(key);
      const content = readAgentsFile(file);
      if (content !== undefined) files.push({ path: file, content, scope: "directory" });
    }
  }
  return files;
}

const BASELINE_HEADER = "AGENTS.md instructions for this workspace. Follow them. When they conflict, a file in a deeper directory wins for files under it, and the user's direct requests win over all of them.";
const DIRECTORY_HEADER = "[AgentBridge] AGENTS.md from a folder you just worked in. Follow it for files under that folder; it takes precedence over broader AGENTS.md files.";

function section(file: AgentsFile, content = file.content): string {
  return `--- AGENTS.md: ${file.path} ---\n${content}\n--- END AGENTS.md ---`;
}

export interface RenderedAgentsFiles {
  readonly text: string;
  /** Files whose content (possibly truncated) is in text. */
  readonly included: AgentsFile[];
}

/**
 * Render files (broad to specific) within `maxBytes`, like DeepSeek Harness: whole broader files
 * are dropped first, then the most specific remaining file is truncated. Returns undefined when
 * there is nothing to send.
 */
export function renderAgentsFiles(files: readonly AgentsFile[], kind: "baseline" | "directory", maxBytes = MAX_AGENTS_MD_BYTES): RenderedAgentsFiles | undefined {
  if (!files.length) return undefined;
  const header = kind === "baseline" ? BASELINE_HEADER : DIRECTORY_HEADER;
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  let kept = [...files];
  const omitted: AgentsFile[] = [];
  const noteFor = (dropped: readonly AgentsFile[]) => dropped.length
    ? `\n\nOmitted to stay within ${maxBytes / 1024} KB: ${dropped.map((file) => file.path).join(", ")}.`
    : "";
  const render = (list: readonly AgentsFile[], dropped: readonly AgentsFile[]) => `${header}\n\n${list.map((file) => section(file)).join("\n\n")}${noteFor(dropped)}`;
  while (kept.length > 1 && bytes(render(kept, omitted)) > maxBytes) omitted.push(kept.shift()!);
  let text = render(kept, omitted);
  if (bytes(text) > maxBytes) {
    const last = kept[kept.length - 1];
    const marker = `\n[... cut off: this AGENTS.md is longer than ${maxBytes / 1024} KB]`;
    const overhead = bytes(render([{ ...last, content: "" }], omitted)) + bytes(marker);
    const room = Math.max(0, maxBytes - overhead);
    let content = Buffer.from(last.content, "utf8").subarray(0, room).toString("utf8");
    while (bytes(content) > room) content = content.slice(0, -1);
    content = content.replace(/\uFFFD+$/, "");
    text = `${header}\n\n${section(last, `${content}${marker}`)}${noteFor(omitted)}`;
  }
  return { text, included: kept };
}
