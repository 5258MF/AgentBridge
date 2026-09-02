export type CloudflaredPrecheckStatus = "unknown" | "pass" | "fail";
export type CloudflaredPrecheckFailureKind = "both-transports" | "dns" | "generic";
export type CloudflaredDiagnosticStream = "stdout" | "stderr";

export interface CloudflaredProcessDiagnostics {
  runId?: string;
  readonly retiredRunIds: Set<string>;
  dns: CloudflaredPrecheckStatus;
  udp: CloudflaredPrecheckStatus;
  tcp: CloudflaredPrecheckStatus;
  dnsTargets: Map<string, "pass" | "fail">;
  udpTargets: Map<string, "pass" | "fail">;
  tcpTargets: Map<string, "pass" | "fail">;
  hardFail: boolean;
  complete: boolean;
  stdoutBuffer: string;
  stderrBuffer: string;
  /** Whole-process rolling tail of cloudflared's output (both streams), capped.
   * Precheck buffers only hold the trailing partial line, so error evidence
   * (QUIC dial failures, registrations) would otherwise be lost. */
  logTail: string;
  /** Count of "Failed to dial ... quic connection" log lines for this process. */
  quicDialFailures: number;
  /** Count of "Registered tunnel connection" log lines for this process. */
  registrationCount: number;
  /** Date.now() of the first observed QUIC dial failure, for fallback grace. */
  firstQuicFailureAt?: number;
}

export interface RepeatedMessageEmission {
  readonly message: string;
  readonly suppressed: number;
}

export interface RepeatedMessageThrottle {
  report(message: string, now?: number): RepeatedMessageEmission | undefined;
  flush(): RepeatedMessageEmission[];
}

const MAX_PENDING_LINE_LENGTH = 8 * 1024;
const MAX_LOG_TAIL_CHARS = 2_000;
/** QUIC dial failures tolerated before the transport is declared unstable. */
export const QUIC_UNSTABLE_DIAL_FAILURES = 2;

export function createCloudflaredProcessDiagnostics(): CloudflaredProcessDiagnostics {
  return {
    retiredRunIds: new Set(),
    dns: "unknown",
    udp: "unknown",
    tcp: "unknown",
    dnsTargets: new Map(),
    udpTargets: new Map(),
    tcpTargets: new Map(),
    hardFail: false,
    complete: false,
    stdoutBuffer: "",
    stderrBuffer: "",
    logTail: "",
    quicDialFailures: 0,
    registrationCount: 0,
  };
}

function resetPrecheckRun(diagnostics: CloudflaredProcessDiagnostics): void {
  diagnostics.dns = "unknown";
  diagnostics.udp = "unknown";
  diagnostics.tcp = "unknown";
  diagnostics.dnsTargets.clear();
  diagnostics.udpTargets.clear();
  diagnostics.tcpTargets.clear();
  diagnostics.hardFail = false;
  diagnostics.complete = false;
}

function selectPrecheckRun(diagnostics: CloudflaredProcessDiagnostics, line: string): boolean {
  const runMatch = line.match(/\brun_id=(?:"([^"]+)"|(\S+))/i);
  const runId = (runMatch?.[1] ?? runMatch?.[2])?.toLowerCase();
  if (!runId) return true;
  if (diagnostics.retiredRunIds.has(runId)) return false;
  if (diagnostics.runId && diagnostics.runId !== runId) {
    diagnostics.retiredRunIds.add(diagnostics.runId);
    resetPrecheckRun(diagnostics);
  }
  diagnostics.runId = runId;
  return true;
}

function updatePrecheckTarget(
  targets: Map<string, "pass" | "fail">,
  target: string,
  status: "pass" | "fail",
): CloudflaredPrecheckStatus {
  targets.set(target, status);
  if ([...targets.values()].some((value) => value === "pass")) return "pass";
  return targets.size > 0 ? "fail" : "unknown";
}

function parseCloudflaredDiagnosticLine(diagnostics: CloudflaredProcessDiagnostics, line: string): void {
  if (!/\bprecheck\s+(?:component|complete)\b/i.test(line)) return;
  if (!selectPrecheckRun(diagnostics, line)) return;
  const component = line.match(/\bprecheck\s+component="([^"]+)".*?\bstatus=(pass|fail)\b/i);
  if (component) {
    const name = component[1].toLowerCase();
    const status = component[2].toLowerCase() as "pass" | "fail";
    const targetMatch = line.match(/\btarget=(?:"([^"]+)"|(\S+))/i);
    const target = (targetMatch?.[1] ?? targetMatch?.[2] ?? "unscoped").toLowerCase();
    if (name === "dns resolution") diagnostics.dns = updatePrecheckTarget(diagnostics.dnsTargets, target, status);
    if (name === "udp connectivity") diagnostics.udp = updatePrecheckTarget(diagnostics.udpTargets, target, status);
    if (name === "tcp connectivity") diagnostics.tcp = updatePrecheckTarget(diagnostics.tcpTargets, target, status);
  }

  const complete = line.match(/\bprecheck\s+complete\b.*?\bhard_fail=(true|false)\b/i);
  if (complete) {
    diagnostics.complete = true;
    diagnostics.hardFail = complete[1].toLowerCase() === "true";
  }
}

/** Track transport-level lifecycle evidence from plain cloudflared log lines
 * (no run_id prefix): QUIC dial failures and successful tunnel registrations.
 * These counters span the whole process lifetime — unlike the precheck state,
 * which is reset per run_id — because the "QUIC unstable" verdict compares
 * failures that predate a registration attempt. */
function parseCloudflaredLifecycleLine(diagnostics: CloudflaredProcessDiagnostics, line: string): void {
  if (/\bRegistered tunnel connection\b/i.test(line)) {
    diagnostics.registrationCount += 1;
    return;
  }
  if (/\bfailed to dial\b[^\n]*\bquic connection\b/i.test(line)) {
    diagnostics.quicDialFailures += 1;
    diagnostics.firstQuicFailureAt ??= Date.now();
  }
}

export function appendCloudflaredDiagnosticOutput(
  diagnostics: CloudflaredProcessDiagnostics,
  stream: CloudflaredDiagnosticStream,
  chunk: string,
): void {
  const bufferKey = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
  const lines = `${diagnostics[bufferKey]}${chunk}`.split(/\r?\n/);
  diagnostics[bufferKey] = (lines.pop() ?? "").slice(-MAX_PENDING_LINE_LENGTH);
  for (const line of lines) {
    if (!line.trim()) continue;
    diagnostics.logTail = `${diagnostics.logTail}${line}\n`.slice(-MAX_LOG_TAIL_CHARS);
    parseCloudflaredLifecycleLine(diagnostics, line);
    parseCloudflaredDiagnosticLine(diagnostics, line);
  }
}

export function cloudflaredSawRegistration(diagnostics: CloudflaredProcessDiagnostics | undefined): boolean {
  return (diagnostics?.registrationCount ?? 0) > 0;
}

export function cloudflaredQuicDialFailures(diagnostics: CloudflaredProcessDiagnostics | undefined): number {
  return diagnostics?.quicDialFailures ?? 0;
}

export function cloudflaredFirstQuicFailureAt(diagnostics: CloudflaredProcessDiagnostics | undefined): number | undefined {
  return diagnostics?.firstQuicFailureAt;
}

/** QUIC transport instability verdict: repeated edge dial failures with zero
 * successful registrations. Once any connection registers, the verdict stays
 * false so a running tunnel is never declared unstable mid-flight. */
export function cloudflaredQuicUnstable(diagnostics: CloudflaredProcessDiagnostics | undefined): boolean {
  return cloudflaredQuicDialFailures(diagnostics) >= QUIC_UNSTABLE_DIAL_FAILURES && !cloudflaredSawRegistration(diagnostics);
}

/** Rolling cloudflared output tail. The full 2000-char tail streams live to
 * the AgentBridge output channel; error-message call sites pass a smaller
 * maxChars so popups stay readable. */
export function cloudflaredLogTail(diagnostics: CloudflaredProcessDiagnostics | undefined, maxChars = 2_000): string {
  const tail = (diagnostics?.logTail ?? "").trim();
  if (tail.length <= maxChars) return tail;
  return `…${tail.slice(-maxChars)}`;
}

export function cloudflaredPrecheckFailureKind(
  diagnostics: CloudflaredProcessDiagnostics | undefined,
): CloudflaredPrecheckFailureKind | undefined {
  if (!diagnostics?.complete || !diagnostics.hardFail) return undefined;
  if (diagnostics.dns === "fail") return "dns";
  if (diagnostics.udp === "fail" && diagnostics.tcp === "fail") return "both-transports";
  return "generic";
}

export function createRepeatedMessageThrottle(intervalMs: number): RepeatedMessageThrottle {
  const entries = new Map<string, { lastEmittedAt: number; suppressed: number }>();
  return {
    report(message: string, now = Date.now()): RepeatedMessageEmission | undefined {
      const entry = entries.get(message);
      if (!entry) {
        entries.set(message, { lastEmittedAt: now, suppressed: 0 });
        return { message, suppressed: 0 };
      }
      if (now - entry.lastEmittedAt < intervalMs) {
        entry.suppressed += 1;
        return undefined;
      }
      const emission = { message, suppressed: entry.suppressed };
      entry.lastEmittedAt = now;
      entry.suppressed = 0;
      return emission;
    },
    flush(): RepeatedMessageEmission[] {
      const emissions: RepeatedMessageEmission[] = [];
      for (const [message, entry] of entries) {
        if (entry.suppressed > 0) emissions.push({ message, suppressed: entry.suppressed });
      }
      entries.clear();
      return emissions;
    },
  };
}
