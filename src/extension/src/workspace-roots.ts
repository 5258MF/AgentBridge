import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

/**
 * Shared multi-root workspace resolution for IDE-side tools (list_directory, get_diagnostics,
 * run_command cwd, lsp, panel resource links).
 *
 * Rules, chosen so a single-folder workspace behaves exactly as before:
 * - Workspace folders are consulted in VS Code order; the first folder always wins ties.
 * - A path that exists in no folder falls back to the first folder (legacy behaviour).
 * - Callers keep their own input policy (e.g. whether absolute paths are accepted) and
 *   their own error messages; this module only decides *which* root a path belongs to.
 */

/** Lexical containment check. Case-insensitive on Windows, like the previous per-tool copies. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const rootCmp = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const candidateCmp = process.platform === "win32" ? candidateResolved.toLowerCase() : candidateResolved;
  return candidateCmp === rootCmp || candidateCmp.startsWith(`${rootCmp}${path.sep}`);
}

/** All open workspace folder paths in VS Code order. Throws when no folder is open. */
export function workspaceRootPaths(): string[] {
  const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  if (!roots.length) throw new Error("No workspace folder is open.");
  return roots;
}

/** First root (in workspace order) that lexically contains the candidate path. */
export function findContainingRoot(roots: readonly string[], candidate: string): string | undefined {
  return roots.find((root) => isInsideRoot(root, candidate));
}

/** Forward-slash path of `absolute` relative to `root`; "." for the root itself. */
export function relativeToRoot(root: string, absolute: string): string {
  return path.relative(root, absolute).replace(/\\/g, "/") || ".";
}

export interface LexicalWorkspacePath {
  root: string;
  absolute: string;
  relative: string;
}

/**
 * Lexically resolve a workspace path against ordered roots without touching symlinks.
 * Absolute input is accepted only when `allowAbsolute` is set (the caller decides the policy).
 * Picks the first containing root in which the path exists; otherwise the first containing root.
 * Returns undefined when no root contains the path, so the caller can raise its own error.
 */
export function resolveLexicalInRoots(
  roots: readonly string[],
  inputPath: string,
  options: { allowAbsolute?: boolean; exists?: (absolute: string) => boolean } = {},
): LexicalWorkspacePath | undefined {
  const exists = options.exists ?? fs.existsSync;
  if (!options.allowAbsolute && path.isAbsolute(inputPath)) return undefined;
  const candidates: LexicalWorkspacePath[] = [];
  for (const root of roots) {
    const absolute = options.allowAbsolute && path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(root, inputPath);
    if (!isInsideRoot(root, absolute)) continue;
    candidates.push({ root, absolute, relative: relativeToRoot(root, absolute) });
  }
  if (candidates.length <= 1) return candidates[0];
  return candidates.find((candidate) => exists(candidate.absolute)) ?? candidates[0];
}

export interface CanonicalWorkspacePath {
  /** Canonical (realpath) root that contains the canonical target. */
  root: string;
  /** Canonical (realpath) target. */
  absolute: string;
  /** Relative path computed lexically, before symlink resolution. */
  lexicalRelative: string;
  /** Relative path of the canonical target inside the canonical root. */
  canonicalRelative: string;
}

/**
 * Resolve an existing workspace path, following symlinks, against ordered roots.
 * For each lexically containing root (in order): both the root and the target are resolved
 * with realpath and the canonical target must stay inside that canonical root.
 * - Missing in a root: try the next root; if missing everywhere, rethrow the first ENOENT.
 * - Present but escaping its root via a symlink: try the next root; if nothing else matches,
 *   throw `outsideError()`.
 * - No containing root at all: throw `outsideError()`.
 * With a single root this is exactly the previous realpath-both-then-check behaviour.
 */
export async function resolveExistingInRoots(
  roots: readonly string[],
  inputPath: string,
  outsideError: () => Error,
  options: { allowAbsolute?: boolean; realpath?: (value: string) => Promise<string> } = {},
): Promise<CanonicalWorkspacePath> {
  const realpath = options.realpath ?? ((value: string) => fs.promises.realpath(value));
  if (!options.allowAbsolute && path.isAbsolute(inputPath)) throw outsideError();
  let firstMissing: unknown;
  let sawOutside = false;
  let sawLexicalCandidate = false;
  for (const root of roots) {
    const absolute = options.allowAbsolute && path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(root, inputPath);
    if (!isInsideRoot(root, absolute)) continue;
    sawLexicalCandidate = true;
    let canonicalRoot: string;
    let canonicalTarget: string;
    try {
      [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(absolute)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        firstMissing ??= error;
        continue;
      }
      throw error;
    }
    if (!isInsideRoot(canonicalRoot, canonicalTarget)) {
      sawOutside = true;
      continue;
    }
    return {
      root: canonicalRoot,
      absolute: canonicalTarget,
      lexicalRelative: relativeToRoot(root, absolute),
      canonicalRelative: relativeToRoot(canonicalRoot, canonicalTarget),
    };
  }
  if (sawOutside || !sawLexicalCandidate) throw outsideError();
  throw firstMissing;
}
