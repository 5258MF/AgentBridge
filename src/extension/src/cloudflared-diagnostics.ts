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

export function appendCloudflaredDiagnosticOutput(
  diagnostics: CloudflaredProcessDiagnostics,
  stream: CloudflaredDiagnosticStream,
  chunk: string,
): void {
  const bufferKey = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
  const lines = `${diagnostics[bufferKey]}${chunk}`.split(/\r?\n/);
  diagnostics[bufferKey] = (lines.pop() ?? "").slice(-MAX_PENDING_LINE_LENGTH);
  for (const line of lines) parseCloudflaredDiagnosticLine(diagnostics, line);
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
