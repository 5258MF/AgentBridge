import { execFile } from "node:child_process";
import { readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";

/** Windows ReplaceFile preserves the existing DACL; ordinary rename does not. */
export async function replaceMcpConfiguration(temporary: string, target: string, expected: string, onCleanupError?: (error: unknown) => void): Promise<void> {
  if (process.platform !== "win32") { await rename(temporary, target); return; }
  if (path.dirname(path.resolve(temporary)) !== path.dirname(path.resolve(target))) throw new Error("MCP replacement must stay in the configuration directory.");
  const backup = temporary + ".backup";
  let committed = false;
  try {
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const sourceName = path.toNamespacedPath(path.resolve(temporary));
    const targetName = path.toNamespacedPath(path.resolve(target));
    const backupName = path.toNamespacedPath(path.resolve(backup));
    await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; [System.AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false); [System.AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false); [System.IO.File]::Replace(${quote(sourceName)}, ${quote(targetName)}, ${quote(backupName)});`], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
    committed = true;
  } catch (error) {
    const actual = await readFile(target, "utf8").catch((failure: NodeJS.ErrnoException) => { if (failure.code === "ENOENT") return undefined; throw failure; });
    if (actual === expected) { committed = true; return; }
    if (actual === undefined) {
      await rename(backup, target).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== "ENOENT") throw failure; });
    }
    throw error;
  } finally {
    // On an uncertain failure, retain the original backup for recovery.
    if (committed) await unlink(backup).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") onCleanupError?.(error); });
  }
}
