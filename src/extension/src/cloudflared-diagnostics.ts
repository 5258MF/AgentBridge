export type CloudflaredPrecheckStatus = "unknown" | "pass" | "fail";
export type CloudflaredPrecheckFailureKind = "both-transports" | "dns" | "generic";
export type CloudflaredDiagnosticStream = "stdout" | "stderr";
export type CloudflaredRequestedProtocol = "auto" | "quic" | "http2";

export interface CloudflaredProcessDiagnostics {
  /** Protocol requested when this exact child was spawned. Unlike the setting,
   * this cannot change while the child is running. */
  readonly requestedProtocol: CloudflaredRequestedProtocol;
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
  /** Date.now() of the first observed QUIC connection failure, for fallback grace. */
  firstQuicFailureAt?: number;
  /** Transport selected by cloudflared for this process. */
  initialProtocol?: "quic" | "http2";
  /** Control-stream evidence retained until the selected protocol is known. */
  controlStreamFailureObserved: boolean;
  /** A QUIC control stream reached the edge but timed out before registration. */
  quicControlStreamFailure: boolean;
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

export function createCloudflaredProcessDiagnostics(
  requestedProtocol: CloudflaredRequestedProtocol,
): CloudflaredProcessDiagnostics {
  return {
    requestedProtocol,
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
    controlStreamFailureObserved: false,
    quicControlStreamFailure: false,
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
 * (no run_id prefix): selected protocol, QUIC failures, and registrations.
 * These counters span the whole process lifetime — unlike the precheck state,
 * which is reset per run_id — because the "QUIC unstable" verdict compares
 * failures that predate a registration attempt. */
function parseCloudflaredLifecycleLine(diagnostics: CloudflaredProcessDiagnostics, line: string): void {
  const protocol = line.match(/\bInitial protocol (quic|http2)\b/i)?.[1]?.toLowerCase();
  if (protocol === "quic" || protocol === "http2") {
    diagnostics.initialProtocol = protocol;
    if (protocol === "quic" && diagnostics.controlStreamFailureObserved) {
      diagnostics.quicControlStreamFailure = true;
      diagnostics.firstQuicFailureAt ??= Date.now();
    }
  }

  if (/\b(?:Registered tunnel connection|connection registered|Connection\s+\S+\s+registered)\b/i.test(line)) {
    diagnostics.registrationCount += 1;
    return;
  }
  if (/\b(?:failed to dial\b[^\n]*\bquic connection|failed to create new quic connection)\b/i.test(line)) {
    diagnostics.quicDialFailures += 1;
    diagnostics.firstQuicFailureAt ??= Date.now();
  }
  const controlStreamFailure = /\bcontrol stream error\b/i.test(line)
    || (/\bRegister tunnel error\b/i.test(line) && /\bcontext deadline exceeded\b/i.test(line));
  if (controlStreamFailure) diagnostics.controlStreamFailureObserved = true;
  if (
    diagnostics.initialProtocol === "quic"
    && diagnostics.controlStreamFailureObserved
  ) {
    diagnostics.quicControlStreamFailure = true;
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
  for (const line of lines) consumeCloudflaredDiagnosticLine(diagnostics, line);
}

function consumeCloudflaredDiagnosticLine(diagnostics: CloudflaredProcessDiagnostics, line: string): void {
  if (!line.trim()) return;
  diagnostics.logTail = `${diagnostics.logTail}${line}\n`.slice(-MAX_LOG_TAIL_CHARS);
  parseCloudflaredLifecycleLine(diagnostics, line);
  parseCloudflaredDiagnosticLine(diagnostics, line);
}

/** Parse the final unterminated line after the process streams close. */
export function flushCloudflaredDiagnosticOutput(
  diagnostics: CloudflaredProcessDiagnostics,
  stream: CloudflaredDiagnosticStream,
): void {
  const bufferKey = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
  const line = diagnostics[bufferKey];
  diagnostics[bufferKey] = "";
  consumeCloudflaredDiagnosticLine(diagnostics, line);
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
  return !cloudflaredSawRegistration(diagnostics)
    && (cloudflaredQuicDialFailures(diagnostics) >= QUIC_UNSTABLE_DIAL_FAILURES || diagnostics?.quicControlStreamFailure === true);
}

/** A dead process cannot recover its current connection attempt, so one
 * explicit QUIC failure is enough to justify the single HTTP/2 retry. The
 * running-process path remains more conservative and waits for the normal
 * unstable verdict plus its grace period. */
export function cloudflaredQuicFailedBeforeRegistration(diagnostics: CloudflaredProcessDiagnostics | undefined): boolean {
  return diagnostics?.requestedProtocol !== "http2"
    && diagnostics?.initialProtocol !== "http2"
    && !cloudflaredSawRegistration(diagnostics)
    && (
      cloudflaredQuicDialFailures(diagnostics) > 0
      || diagnostics?.quicControlStreamFailure === true
      // This helper is used only for an auto-protocol process that has already
      // died. If cloudflared exits before printing Initial protocol, one clear
      // control-stream timeout is sufficient for the single HTTP/2 attempt.
      || diagnostics?.controlStreamFailureObserved === true
    );
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

/**
 * How many distinct messages one throttle remembers.
 *
 * A message that carries a timestamp or a request id is a new key every time it appears, so a
 * long tunnel run used to keep one entry per line for as long as it lasted.
 */
export const THROTTLE_MAX_MESSAGES = 100;

export function createRepeatedMessageThrottle(intervalMs: number): RepeatedMessageThrottle {
  const entries = new Map<string, { lastEmittedAt: number; suppressed: number }>();
  // Counts that were pushed out of `entries` before a flush could report them, so that flushing
  // still reports everything that was held back. Capped for the same reason the map is: without
  // a bound this would be the same leak with a slower fuse.
  let carried: RepeatedMessageEmission[] = [];

  const evictOldest = (): void => {
    for (const [message, entry] of entries) {
      entries.delete(message);
      if (entry.suppressed > 0) {
        if (carried.length >= THROTTLE_MAX_MESSAGES) carried.shift();
        carried.push({ message, suppressed: entry.suppressed });
      }
      return;
    }
  };

  return {
    report(message: string, now = Date.now()): RepeatedMessageEmission | undefined {
      const entry = entries.get(message);
      if (!entry) {
        if (entries.size >= THROTTLE_MAX_MESSAGES) evictOldest();
        entries.set(message, { lastEmittedAt: now, suppressed: 0 });
        return { message, suppressed: 0 };
      }
      entries.delete(message);
      entries.set(message, entry);
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
      if (carried.length === 0) return emissions;
      const pending = carried;
      carried = [];
      return [...pending, ...emissions];
    },
  };
}
