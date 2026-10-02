import path from "node:path";
import { Worker } from "node:worker_threads";
import type { EngineResult, NormalizedOptions, SearchFilesConfig, SearchFilesErrorCode } from "./search-files.js";
import type { NodeSearchCandidates } from "./search-node.js";

export const SEARCH_REGEX_WORKER_FILE = "search-regex-worker.js";
export const SEARCH_REGEX_TIMEOUT_MS = 10_000;
export const MAX_SEARCH_REGEX_WORKERS = 2;
let activeWorkers = 0;

export interface RegexSearchInput {
  candidates: NodeSearchCandidates;
  options: NormalizedOptions;
  config: SearchFilesConfig;
}

export type RegexSearchMessage =
  | { ok: true; result: EngineResult }
  | { ok: false; code: SearchFilesErrorCode; message: string };

export class RegexSearchError extends Error {
  constructor(readonly code: SearchFilesErrorCode, message: string) {
    super(message);
  }
}

export function runRegexSearch(input: RegexSearchInput, signal?: AbortSignal): Promise<EngineResult> {
  if (signal?.aborted) return Promise.reject(new DOMException("Search was cancelled.", "AbortError"));
  if (!Number.isInteger(input.config.regexTimeoutMs) || input.config.regexTimeoutMs < 1) {
    return Promise.reject(new RegexSearchError("INVALID_ARGUMENT", "regexTimeoutMs must be a positive integer."));
  }
  if (activeWorkers >= MAX_SEARCH_REGEX_WORKERS) {
    return Promise.reject(new RegexSearchError("SEARCH_BUSY", "Two fallback regular-expression searches are already running. Wait for one to finish, or use a literal search."));
  }

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(path.join(__dirname, SEARCH_REGEX_WORKER_FILE), {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      });
    } catch (error) {
      reject(new RegexSearchError("IO_ERROR", `Could not start regular-expression search: ${(error as Error).message}`));
      return;
    }
    activeWorkers += 1;
    let settled = false;
    const finish = (result?: EngineResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Hold the slot until the thread has stopped, so rapid cancellations cannot exceed the cap.
      void worker.terminate().catch(() => undefined).then(() => {
        activeWorkers -= 1;
        if (error) reject(error);
        else resolve(result!);
      });
    };
    const onAbort = () => finish(undefined, new DOMException("Search was cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(undefined, new RegexSearchError(
      "SEARCH_TIMEOUT",
      `Fallback regular-expression search exceeded ${input.config.regexTimeoutMs} ms and was stopped. Narrow the search scope, simplify the pattern, or use is_regex=false.`,
    )), input.config.regexTimeoutMs);
    worker.once("message", (message: RegexSearchMessage) => {
      if (message.ok) finish(message.result);
      else finish(undefined, new RegexSearchError(message.code, message.message));
    });
    worker.once("error", (error) => finish(undefined, new RegexSearchError("IO_ERROR", `Regular-expression search failed: ${error.message}`)));
    worker.once("exit", (code) => finish(undefined, new RegexSearchError("IO_ERROR", `Regular-expression search worker exited before returning a result (code ${code}).`)));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
