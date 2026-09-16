import test from "node:test";
import assert from "node:assert/strict";
import { BridgeManager, type BridgeTunnelProvider } from "../src/extension/src/bridge-server.js";
import { childProcessTest, type FakeChildProcess } from "./helpers/fake-child-process.js";
import { httpTest } from "./helpers/fake-http.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { deferred } from "./helpers/panel-harness.js";

const PROVIDERS: BridgeTunnelProvider[] = ["cloudflare", "cloudflare-named", "ngrok"];
const NGROK_DOMAIN = "agentbridge-test.ngrok-free.dev";
const NAMED_DOMAIN = "agentbridge-test.example.com";

function makeContext(): any {
  const secrets = new Map<string, string>();
  const globalState = new Map<string, unknown>();
  secrets.set("agentbridge.bridge.cloudflareNamedTunnelToken", "named-token");
  return {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.10" } },
    subscriptions: [],
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => { secrets.set(key, value); },
      delete: async (key: string) => { secrets.delete(key); },
    },
    globalState: {
      get: <T>(key: string, fallback?: T) => (globalState.has(key) ? globalState.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
  };
}

function makeManager(provider: BridgeTunnelProvider): BridgeManager {
  vscodeTest.reset();
  childProcessTest.reset();
  httpTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.tunnelProvider", provider);
  if (provider === "ngrok") vscodeTest.setConfig("agentbridge.bridge.ngrokDomain", NGROK_DOMAIN);
  if (provider === "cloudflare-named") {
    vscodeTest.setConfig("agentbridge.bridge.cloudflareNamedDomain", NAMED_DOMAIN);
    vscodeTest.setConfig("agentbridge.bridge.cloudflareNamedLocalPort", 49271);
  }
  const output = { append() {}, appendLine() {} } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(makeContext(), output, broker);
}

function startupSignal(provider: BridgeTunnelProvider, child: FakeChildProcess, suffix = "one"): void {
  if (provider === "cloudflare") {
    child.emitStdout(`INF +https://agentbridge-${suffix}.trycloudflare.com ready\n`);
  } else if (provider === "cloudflare-named") {
    child.emitStdout(`INF Connection connector-${suffix} registered connIndex=0\n`);
  } else {
    child.emitStdout(`{"msg":"started tunnel","url":"https://${NGROK_DOMAIN}"}\n`);
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function healthyResponse(ok = true): any {
  return {
    ok: true,
    status: 200,
    body: { cancel: async () => undefined },
    json: async () => ({ ok }),
  };
}

function installFastLifecycleTimers(): () => void {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if ([750, 1000, 4000, 8000, 10000, 15000].includes(Number(delay))) {
      return original(callback, 0, ...args);
    }
    return original(callback, delay, ...args);
  }) as typeof setTimeout;
  return () => { globalThis.setTimeout = original; };
}

async function startManager(manager: BridgeManager, provider: BridgeTunnelProvider, spawnIndex: number, suffix: string): Promise<any> {
  const start = manager.start(provider === "ngrok" ? NGROK_DOMAIN : undefined, { automaticCheck: true });
  await waitFor(() => childProcessTest.spawned.length > spawnIndex, `${provider} tunnel spawn`);
  startupSignal(provider, childProcessTest.spawned[spawnIndex]!, suffix);
  return start;
}

for (const provider of PROVIDERS) {
  test(`${provider}: normal start keeps current tunnel process running`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
    const manager = makeManager(provider);
    try {
      await manager.initialize();
      const status = await startManager(manager, provider, 0, "normal");
      assert.equal(status.state, "running");
      assert.equal(childProcessTest.spawned.length, 1);
      assert.equal(childProcessTest.spawned[0]!.killed, false);
    } finally {
      await manager.stop();
      globalThis.fetch = originalFetch;
    }
  });

  test(`${provider}: stop cancels a pending start and cleans the old process`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
    const manager = makeManager(provider);
    try {
      await manager.initialize();
      const start = manager.start(provider === "ngrok" ? NGROK_DOMAIN : undefined, { automaticCheck: true });
      await waitFor(() => childProcessTest.spawned.length === 1, `${provider} pending spawn`);
      const old = childProcessTest.spawned[0]!;
      const stopped = await manager.stop();
      assert.equal(stopped.state, "stopped");
      assert.equal(old.killed, true, "stop must kill the pending tunnel process");
      old.emitProcessError(new Error("cancelled startup"));
      const startResult = await start;
      assert.equal(startResult.state, "stopped", "cancelled start must not restore running state");
      assert.equal(manager.getStatus().state, "stopped");
    } finally {
      await manager.stop();
      globalThis.fetch = originalFetch;
    }
  });

  for (const staleHealth of [true, false]) {
    test(`${provider}: stale recovery ${staleHealth ? "success" : "failure"} cannot overwrite a newer tunnel`, async () => {
      const originalFetch = globalThis.fetch;
      const restoreTimers = installFastLifecycleTimers();
      const oldHealth = deferred<any>();
      let healthCalls = 0;
      globalThis.fetch = (async () => {
        healthCalls += 1;
        if (healthCalls === 2) return oldHealth.promise;
        return healthyResponse(true);
      }) as typeof fetch;
      const manager = makeManager(provider);
      try {
        await manager.initialize();
        const initial = await startManager(manager, provider, 0, "initial");
        assert.equal(initial.state, "running");

        childProcessTest.spawned[0]!.emitExit(1, null);
        await waitFor(() => childProcessTest.spawned.length >= 2, `${provider} recovery spawn`);
        const recoveryChild = childProcessTest.spawned[1]!;
        startupSignal(provider, recoveryChild, "recovery");
        await waitFor(() => healthCalls >= 2, `${provider} pending recovery health`);

        await manager.stop();
        assert.equal(recoveryChild.killed, true);

        const restart = manager.start(provider === "ngrok" ? NGROK_DOMAIN : undefined, { automaticCheck: true });
        await waitFor(() => childProcessTest.spawned.length >= 3, `${provider} replacement spawn`);
        const replacement = childProcessTest.spawned[2]!;
        startupSignal(provider, replacement, "replacement");
        const restarted = await restart;
        assert.equal(restarted.state, "running");
        const replacementUrl = restarted.publicUrl;

        oldHealth.resolve(healthyResponse(staleHealth));
        await waitFor(() => !(manager as any).tunnelRecoveryPromise, `${provider} stale recovery completion`);

        const final = manager.getStatus();
        assert.equal(final.state, "running");
        assert.equal(final.publicUrl, replacementUrl, "stale recovery callback must not replace the new public endpoint");
        assert.equal(replacement.killed, false, "stale recovery cleanup must not kill the replacement tunnel");
        assert.equal((manager as any).tunnelProcess, replacement, "replacement process must remain current");
      } finally {
        oldHealth.resolve(healthyResponse(staleHealth));
        await manager.stop();
        restoreTimers();
        globalThis.fetch = originalFetch;
      }
    });
  }
}

test("cloudflare-named: an early QUIC control-stream exit retries once with HTTP/2", async () => {
  const originalFetch = globalThis.fetch;
  const restoreTimers = installFastLifecycleTimers();
  let publicHealthCalls = 0;
  let replacementHealthy = false;
  globalThis.fetch = (async () => {
    publicHealthCalls += 1;
    return healthyResponse(replacementHealthy);
  }) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "initial named tunnel spawn");
    const quicChild = childProcessTest.spawned[0]!;
    quicChild.emitStderr('ERR Register tunnel error from server side error="context deadline exceeded" connIndex=0\n');
    quicChild.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"\n');
    quicChild.emitStdout("INF Initial protocol quic\n");
    await waitFor(() => publicHealthCalls > 0, "initial public health attempt");
    quicChild.emitExit(1, null);

    await waitFor(() => childProcessTest.spawned.length === 2, "HTTP/2 fallback spawn");
    const http2Child = childProcessTest.spawned[1]!;
    assert.deepEqual(http2Child.args.slice(0, 4), ["tunnel", "run", "--protocol", "http2"]);
    assert.equal(quicChild.exitCode, 1, "the failed QUIC child must be closed before fallback");

    replacementHealthy = true;
    http2Child.emitStdout("INF Initial protocol http2\nINF Registered tunnel connection connIndex=0\n");
    const status = await start;
    assert.equal(status.state, "running");
    assert.equal((manager as any).tunnelProcess, http2Child);
    assert.equal(childProcessTest.spawned.length, 2, "fallback must run at most once");
    assert.ok(vscodeTest.information.some((message) => message.includes("HTTP/2")));

    vscodeTest.setConfig("agentbridge.bridge.tunnelProtocol", "quic");
    http2Child.emitExit(1, null);
    await waitFor(() => childProcessTest.spawned.length === 3, "explicit QUIC reconnect spawn");
    const explicitQuicChild = childProcessTest.spawned[2]!;
    assert.deepEqual(explicitQuicChild.args.slice(0, 4), ["tunnel", "run", "--protocol", "quic"]);
    explicitQuicChild.emitStdout("INF Initial protocol quic\nINF connection registered connIndex=0\n");
    await waitFor(() => manager.getStatus().state === "running", "explicit QUIC reconnect completion");
    assert.equal((manager as any).tunnelProcess, explicitQuicChild);
  } finally {
    await manager.stop();
    restoreTimers();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare: Quick Tunnel preserves URL discovery across HTTP/2 fallback", async () => {
  const originalFetch = globalThis.fetch;
  const restoreTimers = installFastLifecycleTimers();
  let publicHealthCalls = 0;
  let replacementHealthy = false;
  globalThis.fetch = (async () => {
    publicHealthCalls += 1;
    return healthyResponse(replacementHealthy);
  }) as typeof fetch;
  const manager = makeManager("cloudflare");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "Quick Tunnel QUIC spawn");
    const quicChild = childProcessTest.spawned[0]!;
    quicChild.emitStdout("INF Initial protocol quic\nINF +https://agentbridge-old.trycloudflare.com ready\n");
    await waitFor(() => publicHealthCalls > 0, "Quick Tunnel initial health attempt");
    quicChild.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"\n');
    quicChild.emitExit(1, null);

    await waitFor(() => childProcessTest.spawned.length === 2, "Quick Tunnel HTTP/2 fallback spawn");
    const http2Child = childProcessTest.spawned[1]!;
    assert.deepEqual(http2Child.args.slice(0, 3), ["tunnel", "--protocol", "http2"]);
    replacementHealthy = true;
    http2Child.emitStdout("INF Initial protocol http2\nINF +https://agentbridge-new.trycloudflare.com ready\n");
    const status = await start;
    assert.equal(status.state, "running");
    assert.match(status.publicUrl ?? "", /agentbridge-new\.trycloudflare\.com/);
  } finally {
    await manager.stop();
    restoreTimers();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: a healthy response that races process exit still falls back", async () => {
  const originalFetch = globalThis.fetch;
  const restoreTimers = installFastLifecycleTimers();
  const staleHealth = deferred<any>();
  let publicHealthCalls = 0;
  let replacementHealthy = false;
  globalThis.fetch = (async () => {
    publicHealthCalls += 1;
    if (publicHealthCalls === 1) return staleHealth.promise;
    return healthyResponse(replacementHealthy);
  }) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "health-race QUIC spawn");
    const quicChild = childProcessTest.spawned[0]!;
    quicChild.emitStdout("INF Initial protocol quic\n");
    await waitFor(() => publicHealthCalls === 1, "pending stale health response");

    quicChild.emitExitOnly(1, null);
    staleHealth.resolve(healthyResponse(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(childProcessTest.spawned.length, 1, "a stale healthy response must wait for output drain before fallback");
    quicChild.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"');
    quicChild.emitClose(1, null);

    await waitFor(() => childProcessTest.spawned.length === 2, "health-race HTTP/2 fallback spawn");
    const http2Child = childProcessTest.spawned[1]!;
    assert.deepEqual(http2Child.args.slice(0, 4), ["tunnel", "run", "--protocol", "http2"]);
    replacementHealthy = true;
    http2Child.emitStdout("INF Initial protocol http2\nINF connection registered connIndex=0\n");
    const status = await start;
    assert.equal(status.state, "running");
    assert.equal((manager as any).tunnelProcess, http2Child);
  } finally {
    staleHealth.resolve(healthyResponse(true));
    await manager.stop();
    restoreTimers();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: HTTP/2 replacement waits for the old process to close", async () => {
  const originalFetch = globalThis.fetch;
  const restoreTimers = installFastLifecycleTimers();
  let replacementHealthy = false;
  globalThis.fetch = (async () => healthyResponse(replacementHealthy)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "live QUIC spawn");
    const quicChild = childProcessTest.spawned[0]!;
    quicChild.autoExitOnKill = false;
    quicChild.emitStdout("INF Initial protocol quic\n");
    quicChild.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"\n');
    const diagnostics = (manager as any).cloudflaredProcessDiagnostics.get(quicChild);
    diagnostics.firstQuicFailureAt = Date.now() - 11_000;

    await waitFor(() => quicChild.killed, "old QUIC kill request");
    assert.equal(childProcessTest.spawned.length, 1, "replacement must wait for close, not only kill return");
    quicChild.emitExitOnly(1, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(childProcessTest.spawned.length, 1, "exit alone must not release the HTTP/2 replacement");
    quicChild.emitClose(1, null);

    await waitFor(() => childProcessTest.spawned.length === 2, "post-close HTTP/2 replacement");
    const http2Child = childProcessTest.spawned[1]!;
    replacementHealthy = true;
    http2Child.emitStdout("INF Initial protocol http2\nINF connection registered connIndex=0\n");
    const status = await start;
    assert.equal(status.state, "running");
  } finally {
    await manager.stop();
    restoreTimers();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: process-error recovery waits for the old process to close", async () => {
  const originalFetch = globalThis.fetch;
  const restoreTimers = installFastLifecycleTimers();
  globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const initial = await startManager(manager, "cloudflare-named", 0, "error-recovery");
    assert.equal(initial.state, "running");
    const oldChild = childProcessTest.spawned[0]!;
    oldChild.autoExitOnKill = false;
    oldChild.emitProcessError(new Error("simulated process channel failure"));

    await waitFor(() => oldChild.killed, "process-error kill request");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(childProcessTest.spawned.length, 1, "recovery must wait for close after process error");
    oldChild.emitExitOnly(1, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(childProcessTest.spawned.length, 1, "exit alone must not release process-error recovery");
    oldChild.emitClose(1, null);

    await waitFor(() => childProcessTest.spawned.length === 2, "process-error recovery spawn");
    const replacement = childProcessTest.spawned[1]!;
    replacement.emitStdout("INF Initial protocol quic\nINF Connection recovered-connector registered connIndex=0\n");
    await waitFor(() => manager.getStatus().state === "running", "process-error recovery completion");
    assert.equal((manager as any).tunnelProcess, replacement);
  } finally {
    await manager.stop();
    restoreTimers();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: a QUIC exit during startup retains diagnostics for HTTP/2 fallback", async () => {
  const originalFetch = globalThis.fetch;
  const restoreTimers = installFastLifecycleTimers();
  let replacementHealthy = false;
  globalThis.fetch = (async () => healthyResponse(replacementHealthy)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "startup-stage QUIC spawn");
    const quicChild = childProcessTest.spawned[0]!;
    quicChild.emitStderr('ERR Failed to create new quic connection error="timeout: no recent network activity"');
    quicChild.emitExit(1, null);

    await waitFor(() => childProcessTest.spawned.length === 2, "startup-stage HTTP/2 fallback spawn");
    const http2Child = childProcessTest.spawned[1]!;
    assert.deepEqual(http2Child.args.slice(0, 4), ["tunnel", "run", "--protocol", "http2"]);
    replacementHealthy = true;
    http2Child.emitStdout("INF Initial protocol http2\nINF Registered tunnel connection connIndex=0\n");

    const status = await start;
    assert.equal(status.state, "running");
    assert.equal((manager as any).tunnelProcess, http2Child);
  } finally {
    await manager.stop();
    restoreTimers();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: a control-stream-only startup exit still receives one HTTP/2 attempt", async () => {
  const originalFetch = globalThis.fetch;
  let replacementHealthy = false;
  globalThis.fetch = (async () => healthyResponse(replacementHealthy)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "protocol-less control-stream spawn");
    const failedChild = childProcessTest.spawned[0]!;
    failedChild.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"');
    failedChild.emitExit(1, null);

    await waitFor(() => childProcessTest.spawned.length === 2, "protocol-less HTTP/2 fallback spawn");
    const http2Child = childProcessTest.spawned[1]!;
    assert.deepEqual(http2Child.args.slice(0, 4), ["tunnel", "run", "--protocol", "http2"]);
    replacementHealthy = true;
    http2Child.emitStdout("INF Initial protocol http2\nINF Connection fallback-connector registered connIndex=0\n");
    const status = await start;
    assert.equal(status.state, "running");
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: an HTTP/2 control-stream failure is not misclassified as QUIC", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => healthyResponse(false)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "auto-selected HTTP/2 spawn");
    const child = childProcessTest.spawned[0]!;
    child.emitStdout("INF Initial protocol http2\n");
    child.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"\n');
    child.emitExit(1, null);

    await assert.rejects(start, /The Cloudflare tunnel process exited before the public Bridge health check succeeded/);
    assert.equal(childProcessTest.spawned.length, 1, "an HTTP/2 failure must not trigger a duplicate HTTP/2 fallback");
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: an auto QUIC failure follows a new explicit HTTP/2 setting", async () => {
  const originalFetch = globalThis.fetch;
  let replacementHealthy = false;
  globalThis.fetch = (async () => healthyResponse(replacementHealthy)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "auto QUIC spawn before explicit HTTP/2 change");
    const quicChild = childProcessTest.spawned[0]!;
    quicChild.emitStdout("INF Initial protocol quic\n");
    quicChild.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"\n');
    vscodeTest.setConfig("agentbridge.bridge.tunnelProtocol", "http2");
    quicChild.emitExit(1, null);

    await waitFor(() => childProcessTest.spawned.length === 2, "explicit HTTP/2 replacement spawn");
    const http2Child = childProcessTest.spawned[1]!;
    assert.deepEqual(http2Child.args.slice(0, 4), ["tunnel", "run", "--protocol", "http2"]);
    replacementHealthy = true;
    http2Child.emitStdout("INF Initial protocol http2\nINF Connection explicit-http2 registered connIndex=0\n");
    const status = await start;
    assert.equal(status.state, "running");
    assert.equal((manager as any).tunnelTransportFallback, undefined, "an explicit HTTP/2 setting is not a sticky auto fallback");
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: an explicit QUIC change during startup cancels the pending auto fallback", async () => {
  const originalFetch = globalThis.fetch;
  const pendingHealth = deferred<any>();
  let publicHealthCalls = 0;
  globalThis.fetch = (async () => {
    publicHealthCalls += 1;
    return pendingHealth.promise;
  }) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "protocol-change QUIC spawn");
    const child = childProcessTest.spawned[0]!;
    child.emitStdout("INF Initial protocol quic\n");
    await waitFor(() => publicHealthCalls === 1, "protocol-change pending health request");
    child.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"\n');
    const diagnostics = (manager as any).cloudflaredProcessDiagnostics.get(child);
    diagnostics.firstQuicFailureAt = Date.now() - 11_000;
    vscodeTest.setConfig("agentbridge.bridge.tunnelProtocol", "quic");
    pendingHealth.resolve(healthyResponse(false));

    await assert.rejects(start, /could not sustain QUIC connections/);
    assert.equal(childProcessTest.spawned.length, 1, "the stale auto decision must not override explicit QUIC");
  } finally {
    pendingHealth.resolve(healthyResponse(false));
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: an explicit QUIC change while closing the old process cancels replacement", async () => {
  const originalFetch = globalThis.fetch;
  const restoreTimers = installFastLifecycleTimers();
  globalThis.fetch = (async () => healthyResponse(false)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "closing-window QUIC spawn");
    const child = childProcessTest.spawned[0]!;
    child.autoExitOnKill = false;
    child.emitStdout("INF Initial protocol quic\n");
    child.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"\n');
    const diagnostics = (manager as any).cloudflaredProcessDiagnostics.get(child);
    diagnostics.firstQuicFailureAt = Date.now() - 11_000;

    await waitFor(() => child.killed, "old process close wait");
    vscodeTest.setConfig("agentbridge.bridge.tunnelProtocol", "quic");
    child.emitExitOnly(1, null);
    child.emitClose(1, null);

    await assert.rejects(start, /could not sustain QUIC connections/);
    assert.equal(childProcessTest.spawned.length, 1, "the replacement must honor the latest explicit QUIC setting");
  } finally {
    await manager.stop();
    restoreTimers();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: close without exit terminates health polling instead of spinning", async () => {
  const originalFetch = globalThis.fetch;
  const pendingHealth = deferred<any>();
  let publicHealthCalls = 0;
  globalThis.fetch = (async () => {
    publicHealthCalls += 1;
    return pendingHealth.promise;
  }) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "close-without-exit spawn");
    const child = childProcessTest.spawned[0]!;
    child.emitStdout("INF Initial protocol http2\n");
    await waitFor(() => publicHealthCalls === 1, "close-without-exit health request");
    child.emitProcessError(new Error("transport setup failed"));
    child.emitClose(null, null);
    pendingHealth.resolve(healthyResponse(false));

    await assert.rejects(start, /The Cloudflare tunnel process exited before the public Bridge health check succeeded/);
    assert.equal(publicHealthCalls, 1, "an aborted lifecycle must not enter a fast retry loop");
  } finally {
    pendingHealth.resolve(healthyResponse(false));
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: an explicit HTTP/2 early exit stays localized and does not retry", async () => {
  const originalFetch = globalThis.fetch;
  const restoreTimers = installFastLifecycleTimers();
  let publicHealthCalls = 0;
  globalThis.fetch = (async () => {
    publicHealthCalls += 1;
    return healthyResponse(false);
  }) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  vscodeTest.setConfig("agentbridge.bridge.tunnelProtocol", "http2");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "explicit HTTP/2 tunnel spawn");
    const child = childProcessTest.spawned[0]!;
    child.emitStdout("INF Initial protocol http2\n");
    await waitFor(() => publicHealthCalls > 0, "explicit HTTP/2 public health attempt");
    child.emitStderr("ERR connector stopped unexpectedly\n");
    child.emitExit(1, null);

    await assert.rejects(start, /The Cloudflare tunnel process exited before the public Bridge health check succeeded/);
    assert.equal(childProcessTest.spawned.length, 1, "an explicit protocol choice must never be overridden");
  } finally {
    await manager.stop();
    restoreTimers();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: explicit HTTP/2 without a protocol log never enters QUIC fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => healthyResponse(false)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  vscodeTest.setConfig("agentbridge.bridge.tunnelProtocol", "http2");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "protocol-log-free explicit HTTP/2 spawn");
    const child = childProcessTest.spawned[0]!;
    assert.deepEqual(child.args.slice(0, 4), ["tunnel", "run", "--protocol", "http2"]);
    child.emitStderr('ERR initial tunnel connection failed error="control stream error: context deadline exceeded"\n');
    child.emitExit(1, null);

    await assert.rejects(start, /The Cloudflare tunnel process exited before the public Bridge health check succeeded/);
    assert.equal(childProcessTest.spawned.length, 1, "an explicit HTTP/2 child must fail once instead of recursively restarting");
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: stop followed immediately by start does not reuse the cancelled start", async () => {
  const originalFetch = globalThis.fetch;
  const pendingOldHealth = deferred<any>();
  let publicHealthCalls = 0;
  globalThis.fetch = (async () => {
    publicHealthCalls += 1;
    if (publicHealthCalls === 1) return pendingOldHealth.promise;
    return healthyResponse(true);
  }) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const oldStart = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "old pending start spawn");
    const oldChild = childProcessTest.spawned[0]!;
    oldChild.autoExitOnKill = false;
    oldChild.emitStdout("INF Initial protocol quic\nINF connection registered connIndex=0\n");
    await waitFor(() => publicHealthCalls === 1, "old pending health request");

    const stop = manager.stop();
    await waitFor(() => oldChild.killed, "old process stop request");
    let stopFinished = false;
    void stop.then(() => { stopFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopFinished, false, "Stop must wait for the old child to close");
    oldChild.emitExit(1, null);
    const stopped = await stop;
    assert.equal(stopped.state, "stopped");
    const restart = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 2, "fresh start after stop");
    const replacement = childProcessTest.spawned[1]!;
    replacement.emitStdout("INF Initial protocol quic\nINF connection registered connIndex=0\n");
    const restarted = await restart;
    assert.equal(restarted.state, "running");
    assert.equal((manager as any).tunnelProcess, replacement);

    oldChild.emitExit(1, null);
    pendingOldHealth.resolve(healthyResponse(true));
    await oldStart;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.getStatus().state, "running", "a stale old-child exit must not start recovery");
    assert.equal((manager as any).tunnelProcess, replacement);
    assert.equal(childProcessTest.spawned.length, 2);
  } finally {
    pendingOldHealth.resolve(healthyResponse(false));
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: start requested while Stop is closing resources waits and really restarts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const initial = await startManager(manager, "cloudflare-named", 0, "before-concurrent-stop");
    assert.equal(initial.state, "running");
    const oldChild = childProcessTest.spawned[0]!;
    oldChild.autoExitOnKill = false;

    const stop = manager.stop();
    await waitFor(() => oldChild.killed, "concurrent Stop kill request");
    let restartFinished = false;
    const restart = manager.start(undefined, { automaticCheck: true }).then((status) => {
      restartFinished = true;
      return status;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(restartFinished, false, "Start must wait while Stop still owns the resources");
    assert.equal(childProcessTest.spawned.length, 1, "no replacement may spawn before the old process closes");

    oldChild.emitExitOnly(null, "SIGTERM");
    oldChild.emitClose(null, "SIGTERM");
    await stop;
    await waitFor(() => childProcessTest.spawned.length === 2, "post-Stop restart spawn");
    const replacement = childProcessTest.spawned[1]!;
    replacement.emitStdout("INF Initial protocol quic\nINF Connection post-stop registered connIndex=0\n");

    const restarted = await restart;
    assert.equal(restarted.state, "running");
    assert.equal((manager as any).tunnelProcess, replacement);
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});
