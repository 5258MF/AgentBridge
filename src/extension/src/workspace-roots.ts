import * as fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

/**
 * The folders a window is made of, and how a workspace-relative path finds its folder.
 *
 * The file tools take every root: `read_files`, `find_files`, `apply_patch` and `search_files`
 * are handed the whole list and resolve against all of it. The IDE side used to take
 * `workspaceFolders[0]` and nothing else, so in a window with two folders a path belonging to
 * the second one was resolved against the first - a click in the panel opened a file that does
 * not exist there, and `run_command`, `lsp` and `list_directory` answered "Path is outside the
 * workspace" for a path that is inside the window.
 */

/** Every folder in the window, in the order VS Code lists them. */
export function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error("No workspace folder is open.");
  return folders;
}

/** Every folder in the window, as a path. */
export function workspaceRoots(): string[] {
  return workspaceFolders().map((folder) => folder.uri.fsPath);
}

/**
 * The folder a path is written against when nothing says otherwise - the first one, which is
 * what a single-root window has always meant.
 */
export function defaultWorkspaceRoot(): string {
  return workspaceRoots()[0]!;
}

/** Whether `target` is `root` itself or something under it. */
export function isInsideRoot(root: string, target: string): boolean {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const rootCmp = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const targetCmp = process.platform === "win32" ? targetResolved.toLowerCase() : targetResolved;
  return targetCmp === rootCmp || targetCmp.startsWith(`${rootCmp}${path.sep}`);
}

/** Whether an absolute path is inside any folder of the window. */
export function isInsideAnyWorkspaceRoot(target: string): boolean {
  return workspaceRoots().some((root) => isInsideRoot(root, target));
}

/** Whether an absolute path is inside any of `roots`. */
export function isInsideAnyRoot(roots: readonly string[], target: string): boolean {
  return roots.some((root) => isInsideRoot(root, target));
}

/**
 * The folders with their symlinks resolved.
 *
 * A path that came back from realpath has to be judged against roots that went through it
 * too: on Windows the temporary directory is handed out in its short 8.3 spelling, so an
 * unresolved root and a resolved target disagreed about where the workspace ends.
 */
export async function canonicalWorkspaceRoots(): Promise<string[]> {
  return Promise.all(workspaceRoots().map((root) => fs.promises.realpath(root)));
}

/**
 * The folder that holds `relative`, and the first one when none of them does.
 *
 * A relative path is inside every root lexically, so something has to choose: the folder that
 * actually has the entry wins, and a path nothing has yet - a directory a caller is about to
 * create, or a name it merely guessed - keeps resolving against the first folder, which is what
 * it did before there was anything to choose between.
 */
export function workspaceRootHolding(relative: string): string {
  const roots = workspaceRoots();
  const normalized = relative.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return roots[0]!;
  if (path.isAbsolute(normalized)) {
    return roots.find((root) => isInsideRoot(root, normalized)) ?? roots[0]!;
  }
  for (const root of roots) {
    if (fs.existsSync(path.resolve(root, normalized))) return root;
  }
  return roots[0]!;
}

/** The folder that holds `relative`, resolved through symlinks. */
export async function canonicalWorkspaceRootHolding(relative: string): Promise<string> {
  return fs.promises.realpath(workspaceRootHolding(relative));
}
