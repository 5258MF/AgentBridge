import test from "node:test";
import assert from "node:assert/strict";
import {
  appendCloudflaredDiagnosticOutput,
  cloudflaredLogTail,
  cloudflaredPrecheckFailureKind,
  cloudflaredQuicDialFailures,
  cloudflaredQuicUnstable,
  cloudflaredSawRegistration,
  createCloudflaredProcessDiagnostics,
  createRepeatedMessageThrottle,
  QUIC_UNSTABLE_DIAL_FAILURES,
  THROTTLE_MAX_MESSAGES,
} from "../src/extension/src/cloudflared-diagnostics.js";

function feed(lines: string[]): ReturnType<typeof createCloudflaredProcessDiagnostics> {
  const diagnostics = createCloudflaredProcessDiagnostics("auto");
  for (const line of lines) appendCloudflaredDiagnosticOutput(diagnostics, "stderr", `${line}\n`);
  return diagnostics;
}

const dnsFail = 'precheck component="DNS Resolution" status=fail target="one.one.one.one" run_id=aaa';
const dnsPass = 'precheck component="DNS Resolution" status=pass target="one.one.one.one" run_id=aaa';

test("a precheck component is read from a cloudflared log line", () => {
  const diagnostics = feed([dnsFail]);
  assert.equal(diagnostics.dns, "fail");
  assert.equal(diagnostics.dnsTargets.get("one.one.one.one"), "fail");
  assert.equal(cloudflaredPrecheckFailureKind(diagnostics), undefined, "a verdict needs precheck to be complete");
});

test("a new run retires the verdict the previous one was building", () => {
  // cloudflared restarts its precheck without restarting the process, so a failure from the
  // run that was abandoned must not be carried into the one that replaced it.
  const diagnostics = feed([dnsFail, dnsPass.replace("run_id=aaa", "run_id=bbb")]);
  assert.equal(diagnostics.dns, "pass");
  assert.equal(diagnostics.dnsTargets.size, 1, "the new run starts from a clean set of targets");
});

test("a line from a retired run is ignored", () => {
  const diagnostics = feed([dnsFail, dnsPass.replace("run_id=aaa", "run_id=bbb")]);
  appendCloudflaredDiagnosticOutput(diagnostics, "stderr", `${dnsFail}\n`);
  assert.equal(diagnostics.dns, "pass", "the retired run must not overwrite the live verdict");
});

test("one reachable target is enough to call a component healthy", () => {
  const diagnostics = feed([
    'precheck component="DNS Resolution" status=fail target="8.8.8.8" run_id=aaa',
    'precheck component="DNS Resolution" status=pass target="1.1.1.1" run_id=aaa',
  ]);
  assert.equal(diagnostics.dns, "pass");
});

test("a completed precheck with a hard failure is classified by what failed", () => {
  const dns = feed([dnsFail, "precheck complete hard_fail=true run_id=aaa"]);
  assert.equal(cloudflaredPrecheckFailureKind(dns), "dns");

  const transports = feed([
    'precheck component="UDP Connectivity" status=fail target="edge" run_id=aaa',
    'precheck component="TCP Connectivity" status=fail target="edge" run_id=aaa',
    "precheck complete hard_fail=true run_id=aaa",
  ]);
  assert.equal(cloudflaredPrecheckFailureKind(transports), "both-transports");

  const other = feed([dnsPass, "precheck complete hard_fail=true run_id=aaa"]);
  assert.equal(cloudflaredPrecheckFailureKind(other), "generic");
});

test("a completed precheck that is not a hard failure has no verdict", () => {
  assert.equal(cloudflaredPrecheckFailureKind(feed([dnsFail, "precheck complete hard_fail=false run_id=aaa"])), undefined);
});

test("repeated QUIC dial failures with no registration make the transport unstable", () => {
  const diagnostics = createCloudflaredProcessDiagnostics("auto");
  const dial = "Failed to dial 198.41.192.7: a quic connection";
  for (let index = 0; index < QUIC_UNSTABLE_DIAL_FAILURES - 1; index += 1) {
    appendCloudflaredDiagnosticOutput(diagnostics, "stderr", `${dial}\n`);
    assert.equal(cloudflaredQuicUnstable(diagnostics), false, `${index + 1} failures are not enough yet`);
  }
  appendCloudflaredDiagnosticOutput(diagnostics, "stderr", `${dial}\n`);
  assert.equal(cloudflaredQuicDialFailures(diagnostics), QUIC_UNSTABLE_DIAL_FAILURES);
  assert.equal(cloudflaredQuicUnstable(diagnostics), true);
});

test("a registration keeps the transport stable however many dials failed", () => {
  // A tunnel that is up is never declared unstable mid-flight: the counter only matters
  // while no edge has ever been reached.
  const diagnostics = feed(["Registered tunnel connection", "Failed to dial: a quic connection", "Failed to dial: a quic connection"]);
  assert.equal(cloudflaredSawRegistration(diagnostics), true);
  assert.equal(cloudflaredQuicDialFailures(diagnostics), 2);
  assert.equal(cloudflaredQuicUnstable(diagnostics), false);
});

test("a line is only read once it is complete", () => {
  const diagnostics = createCloudflaredProcessDiagnostics("auto");
  appendCloudflaredDiagnosticOutput(diagnostics, "stderr", "2026-09-15 Failed to dial 198.41.192.7:");
  assert.equal(cloudflaredQuicDialFailures(diagnostics), 0, "a half line is not a failure yet");
  appendCloudflaredDiagnosticOutput(diagnostics, "stderr", " a quic connection\n");
  assert.equal(cloudflaredQuicDialFailures(diagnostics), 1);
});

test("the log tail keeps the last lines of both streams", () => {
  const diagnostics = createCloudflaredProcessDiagnostics("auto");
  appendCloudflaredDiagnosticOutput(diagnostics, "stdout", "starting\n");
  appendCloudflaredDiagnosticOutput(diagnostics, "stderr", "registered\n");
  assert.equal(cloudflaredLogTail(diagnostics), "starting\nregistered");
  assert.equal(cloudflaredLogTail(undefined), "");
});

test("the log tail is cut from the front so the newest evidence survives", () => {
  const diagnostics = createCloudflaredProcessDiagnostics("auto");
  for (let index = 0; index < 400; index += 1) {
    appendCloudflaredDiagnosticOutput(diagnostics, "stderr", `line ${index} of a very long start-up\n`);
  }
  const tail = cloudflaredLogTail(diagnostics, 40);
  assert.ok(tail.startsWith("…"), tail);
  assert.ok(tail.endsWith("a very long start-up"), tail);
  assert.ok(tail.length <= 41, String(tail.length));
});

test("a repeated message is reported once and the rest are counted", () => {
  const throttle = createRepeatedMessageThrottle(1_000);
  assert.deepEqual(throttle.report("cloudflared is slow", 1_000), { message: "cloudflared is slow", suppressed: 0 });
  assert.equal(throttle.report("cloudflared is slow", 1_500), undefined, "a repeat inside the interval is held back");
  assert.equal(throttle.report("cloudflared is slow", 1_900), undefined);
  assert.deepEqual(throttle.report("cloudflared is slow", 2_100), { message: "cloudflared is slow", suppressed: 2 });
  assert.deepEqual(throttle.flush(), []);
});

test("a flush reports what was held back and starts over", () => {
  const throttle = createRepeatedMessageThrottle(1_000);
  throttle.report("one", 0);
  throttle.report("one", 100);
  throttle.report("two", 100);
  throttle.report("two", 200);
  assert.deepEqual(throttle.flush(), [
    { message: "one", suppressed: 1 },
    { message: "two", suppressed: 1 },
  ]);
  assert.deepEqual(throttle.flush(), [], "a flush clears what it reported");
  assert.deepEqual(throttle.report("one", 300), { message: "one", suppressed: 0 });
});

test("a message that keeps changing is not remembered for longer than the cap", () => {
  // The table was keyed on the whole message and never shrank, so a message carrying a
  // timestamp or a request id - new text every time it appears - kept one entry per line for
  // as long as the tunnel ran. The bound is what makes that harmless; what is pushed out is
  // reported rather than lost, because a count held back is a count a flush has to hand over.
  const throttle = createRepeatedMessageThrottle(1_000);
  for (let index = 0; index < 100_000; index += 1) {
    assert.equal(throttle.report(`attempt ${index} failed`, 0)?.suppressed, 0);
  }

  // The first message has long since been pushed out, so it reads as new again...
  assert.deepEqual(throttle.report("attempt 0 failed", 0), { message: "attempt 0 failed", suppressed: 0 });
  // ...while the last ones are still held, and a repeat inside the interval is still held back.
  assert.equal(throttle.report("attempt 99999 failed", 0), undefined, "a recent message is remembered");
  assert.equal(throttle.report("attempt 99998 failed", 0), undefined);
});

test("what a flush reports is bounded too", () => {
  const throttle = createRepeatedMessageThrottle(1_000);
  for (let index = 0; index < 10_000; index += 1) {
    throttle.report(`attempt ${index} failed`, 0);
    throttle.report(`attempt ${index} failed`, 1);
  }
  const flushed = throttle.flush();
  assert.ok(
    flushed.length <= THROTTLE_MAX_MESSAGES * 2,
    `a flush cannot carry more than the throttle remembers: ${flushed.length}`,
  );
  assert.ok(flushed.length > 0, "and it does not silently drop everything");
  for (const emission of flushed) assert.equal(emission.suppressed, 1);
  assert.deepEqual(throttle.flush(), [], "a flush clears what it reported");
});
