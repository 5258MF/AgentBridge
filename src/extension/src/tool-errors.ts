/**
 * Stable, model-facing error codes for AgentBridge tool failures.
 *
 * Every failed tool result starts with an UPPER_SNAKE_CASE code followed by a colon and a
 * human-readable message, optionally followed by a "Hint:" line with a concrete recovery.
 * Models recover more reliably from a fixed code than from free text, and the code stays
 * stable when the message wording changes. The file tools already throw "CODE: message"
 * errors (INVALID_ARGUMENT, TOO_MANY_FILES, STALE_FILE, ...); those are passed through as-is.
 */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const CODE_PREFIX = /^[A-Z][A-Z0-9_]{2,}:\s/;
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * Render any thrown value as "CODE: message[\nHint: ...]".
 * @param error - the thrown value.
 * @param fallbackCode - code used when the error carries none (e.g. INVALID_ARGUMENT for validators).
 */
export function formatToolError(error: unknown, fallbackCode = "TOOL_FAILED"): string {
  if (error instanceof ToolError) {
    return `${error.code}: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ""}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (CODE_PREFIX.test(message)) return message;
  const ownCode = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const code = typeof ownCode === "string" && CODE_SHAPE.test(ownCode) ? ownCode : fallbackCode;
  return `${code}: ${message}`;
}
