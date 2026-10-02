// One Node fallback regex search per worker. The host can terminate this thread
// even while RegExp.exec() is stuck in catastrophic backtracking.
import { parentPort, workerData } from "node:worker_threads";
import { NodeSearchPatternError, scanNodeSearchFiles } from "./search-node.js";
import type { RegexSearchInput, RegexSearchMessage } from "./search-regex-runner.js";

const input = workerData as RegexSearchInput;
void scanNodeSearchFiles(input.candidates, input.options, input.config).then((result) => {
  parentPort?.postMessage({ ok: true, result } satisfies RegexSearchMessage);
}, (error: unknown) => {
  const errno = (error as NodeJS.ErrnoException)?.code;
  const code = error instanceof NodeSearchPatternError ? "INVALID_PATTERN"
    : errno === "ENOENT" ? "FILE_NOT_FOUND"
    : errno === "EACCES" || errno === "EPERM" ? "PERMISSION_DENIED" : "IO_ERROR";
  parentPort?.postMessage({ ok: false, code, message: error instanceof Error ? error.message : String(error) } satisfies RegexSearchMessage);
});
