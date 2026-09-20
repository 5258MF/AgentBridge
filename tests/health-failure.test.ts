import test from "node:test";
import assert from "node:assert/strict";
import {
  publicHealthFailure,
  isDeterministicHealthStatus,
  publicHealthTimeLeft,
  publicHealthBudgetExhausted,
  publicHealthAttemptTimeout,
  nextDeterministicFailureCount,
} from "../src/extension/src/bridge-server.js";

function withCode(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

test("network failures that cannot succeed by retrying are deterministic", () => {
  for (const code of [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    // Unreachable networks: a campus or corporate network that blackholes the tunnel host
    // would otherwise burn the whole startup budget before the user hears anything.
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ECONNABORTED",
    "EPROTO",
  ]) {
    const failure = publicHealthFailure(withCode(`request to https://example.test failed`, code));
    assert.equal(failure.deterministic, true, code);
    assert.equal(failure.code, code);
  }
});

test("TLS interception is deterministic even without an error code", () => {
  for (const message of [
    "self-signed certificate in certificate chain",
    "unable to verify the first certificate",
    "wrong version number",
  ]) {
    const failure = publicHealthFailure(new Error(message));
    assert.equal(failure.deterministic, true, message);
  }
});

test("a protocol error that OpenSSL reports only in its own words is still deterministic", () => {
  // Dropping the bare "tls"/"ssl" test must not drop the failures it was written for. These
  // arrive as a protocol error, and EPROTO is already in the deterministic set.
  for (const message of [
    "write EPROTO 101057795:error:141A318A:SSL routines:tls_process_ske_dhe:dh key too small",
    "write EPROTO 101057795:error:1408F10B:SSL routines:ssl3_get_record:wrong version number",
  ]) {
    const failure = publicHealthFailure(withCode(message, "EPROTO"));
    assert.equal(failure.deterministic, true, message);
  }
});

test("a path or tool name containing ssl is not read as a certificate problem", () => {
  // The reason string carries more than the error: file paths and tool names end up in it.
  // Testing "ssl" as a substring read those as a TLS failure, gave up on startup and pointed
  // the user at interception they were not suffering from.
  for (const message of [
    "ENOENT: no such file or directory, open 'C:\\tools\\ssl\\cloudflared.log'",
    "spawn ENOENT: openssl-wrapper is not installed",
    "the proxy offered starttls and then hung up",
  ]) {
    const failure = publicHealthFailure(new Error(message));
    assert.equal(failure.deterministic, false, message);
  }
});

test("timeouts and unknown errors stay retryable", () => {
  for (const error of [withCode("socket hang up", "ETIMEDOUT"), new Error("boom"), withCode("busy", "EBUSY")]) {
    assert.equal(publicHealthFailure(error).deterministic, false);
  }
});

test("an endpoint that refuses us does not need retrying", () => {
  // A proxy or gateway answering 401/403/407 will keep answering that way; there is nothing
  // for a retry to correct, so startup should say so instead of burning the budget.
  for (const status of [401, 403, 407]) {
    assert.equal(isDeterministicHealthStatus(status), true, `HTTP ${status}`);
  }
});

test("a missing endpoint stays retryable", () => {
  // The health endpoint genuinely does not exist until the tunnel is up.
  assert.equal(isDeterministicHealthStatus(404), false);
  assert.equal(isDeterministicHealthStatus(500), false);
  assert.equal(isDeterministicHealthStatus(200), false);
});

test("a fallback request is capped by what is left of the budget", () => {
  // Only the first request was bounded by the remaining time; every DoH endpoint and pinned
  // anycast retry then started a fresh five seconds, so one attempt outlived the startup
  // budget the user configured by tens of seconds.
  assert.equal(publicHealthAttemptTimeout(undefined), 5_000);
  assert.equal(publicHealthAttemptTimeout(20_000), 5_000);
  assert.equal(publicHealthAttemptTimeout(2_000), 2_000);
});

test("a nearly exhausted budget still lets one request finish", () => {
  assert.equal(publicHealthAttemptTimeout(200), 1_000);
  assert.equal(publicHealthAttemptTimeout(-4_000), 1_000);
});

test("an exhausted budget stops the fallback chain", () => {
  const now = 1_000;
  assert.equal(publicHealthTimeLeft(undefined, now), undefined);
  assert.equal(publicHealthTimeLeft(6_000, now), 5_000);
  assert.equal(publicHealthBudgetExhausted(undefined, now), false);
  assert.equal(publicHealthBudgetExhausted(6_000, now), false);
  assert.equal(publicHealthBudgetExhausted(1_000, now), true);
  assert.equal(publicHealthBudgetExhausted(500, now), true);
});

test("the cause chain is walked for the code and joined into the reason", () => {
  const cause = withCode("getaddrinfo ENOTFOUND tunnel.example.test", "ENOTFOUND");
  const failure = publicHealthFailure(Object.assign(new Error("fetch failed"), { cause }));
  assert.equal(failure.deterministic, true);
  assert.equal(failure.code, "ENOTFOUND");
  assert.ok(failure.reason.includes("fetch failed"), failure.reason);
  assert.ok(failure.reason.includes("getaddrinfo ENOTFOUND"), failure.reason);
});

test("a run of deterministic failures gives up on the third one", () => {
  const first = nextDeterministicFailureCount(0, true);
  assert.deepEqual(first, { count: 1, giveUp: false });
  const second = nextDeterministicFailureCount(first.count, true);
  assert.deepEqual(second, { count: 2, giveUp: false });
  const third = nextDeterministicFailureCount(second.count, true);
  assert.deepEqual(third, { count: 3, giveUp: true });
});

test("any non-deterministic attempt clears the run", () => {
  // A tunnel that answered once can answer again, so the count has to mean "consecutive".
  // This covers the failure the classifier does not recognise as well as a plain success:
  // an unknown cause must not inherit the previous run's momentum.
  const afterOne = nextDeterministicFailureCount(0, true);
  assert.equal(nextDeterministicFailureCount(afterOne.count, false).count, 0);
  assert.equal(nextDeterministicFailureCount(afterOne.count, undefined).count, 0);
  assert.equal(nextDeterministicFailureCount(2, undefined).giveUp, false);
});

test("the deterministic limit is only reached by counting, never by a single attempt", () => {
  // Regression: the limit used to be compared against the pre-increment count through a
  // second, separately written condition, so the two could drift apart.
  assert.equal(nextDeterministicFailureCount(2, false, 3).giveUp, false);
  assert.equal(nextDeterministicFailureCount(0, true, 1).giveUp, true);
});
