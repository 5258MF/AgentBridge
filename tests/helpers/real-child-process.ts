import { createRequire } from "node:module";
import path from "node:path";

// The test bundler replaces "node:child_process" with a fake so tests never spawn real
// processes by accident. Some assertions — for example verifying that a bridged PowerShell
// script really exits with the command's code — have to run the real thing. createRequire
// resolves through Node itself and therefore bypasses the bundler's module replacement.
const requireFromWorkspace = createRequire(path.join(process.cwd(), "package.json"));
const realChildProcess = requireFromWorkspace("node:child_process") as typeof import("node:child_process");

export const execFileSync = realChildProcess.execFileSync;
