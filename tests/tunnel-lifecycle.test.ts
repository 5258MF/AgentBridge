import test from "node:test";
import assert from "node:assert/strict";
import { BridgeManager, type BridgeTunnelProvider } from "../src/extension/src/bridge-server.js";
import { childProcessTest, type FakeChildProcess } from "./helpers/fake-child-process.js";
import { httpTest } from "./helpers/fake-http.js";
import { httpsTest } from "./helpers/fake-https.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { deferred } from "./helpers/panel-harness.js";

const PROVIDERS: BridgeTunnelProvider[] = ["cloudflare", "cloudflare-named", "ngrok"];
const NGROK_DOMAIN = "agentbridge-test.ngrok-free.dev";
const NAMED_DOMAIN = "agentbridge-test.example.com";

function makeContext(extensionMode = 1): any {
  const secrets = new Map<string, string>();
  const globalState = new Map<string, unknown>();
  secrets.set("agentbridge.bridge.cloudflareNamedTunnelToken", "named-token");
  return {
    extensionMode,
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

function makeManager(provider: BridgeTunnelProvider, extensionMode = 1): BridgeManager {
  vscodeTest.reset();
  childProcessTest.reset();
  httpTest.reset();
  httpsTest.reset();
  vscodeTest.setConfig("agentbridge.bridge.tunnelProvider", provider);
  if (provider === "ngrok") vscodeTest.setConfig("agentbridge.bridge.ngrokDomain", NGROK_DOMAIN);
  if (provider === "cloudflare-named") {
    vscodeTest.setConfig("agentbridge.bridge.cloudflareNamedDomain", NAMED_DOMAIN);
    vscodeTest.setConfig("agentbridge.bridge.cloudflareNamedLocalPort", 49271);
  }
  const output = { append() {}, appendLine() {} } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(makeContext(extensionMode), output, broker);
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
    if ([750, 1000, 4000, 8000, 15000].includes(Number(delay))) {
      return original(callback, 0, ...args);
    }
    return original(callback, delay, ...args);
  }) as typeof setTimeout;
  return () => { globalThis.setTimeout = original; };
}

function installControlledPublicHealthTimers(delayMs = 10_000): {
  pendingCount: () => number;
  fireNext: () => void;
  restore: () => void;
} {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pending = new Map<object, () => void>();
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (Number(delay) !== delayMs) return originalSetTimeout(callback, delay, ...args);
    const handle = { unref() {} };
    pending.set(handle, () => callback(...args));
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    if (pending.delete(handle as unknown as object)) return;
    originalClearTimeout(handle);
  }) as typeof clearTimeout;
  return {
    pendingCount: () => pending.size,
    fireNext: () => {
      const entry = pending.entries().next().value as [object, () => void] | undefined;
      if (!entry) throw new Error(`No controlled ${delayMs}ms timer is pending.`);
      pending.delete(entry[0]);
      entry[1]();
    },
    restore: () => {
      pending.clear();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
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

test("cloudflare-named: a process error during startup aborts a hanging health request", async () => {
  const originalFetch = globalThis.fetch;
  let healthCalls = 0;
  globalThis.fetch = (async () => {
    healthCalls += 1;
    return new Promise<any>(() => undefined);
  }) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const start = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 1, "startup process-error tunnel");
    const child = childProcessTest.spawned[0]!;
    child.emitStdout("INF Initial protocol http2\nINF Connection startup-error registered connIndex=0\n");
    await waitFor(() => healthCalls === 1, "hanging startup health request");
    child.emitProcessError(new Error("simulated startup process failure"));

    await assert.rejects(start, /simulated startup process failure/);
    assert.equal(child.killed, true);
    assert.notEqual(manager.getStatus().state, "running");
  } finally {
    await manager.stop();
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

test("cloudflare: a stale process URL cannot overwrite the current generation domain", async () => {
  const manager = makeManager("cloudflare");
  try {
    await manager.initialize();
    (manager as any).localPort = 41000;
    const oldGeneration = (manager as any).tunnelGeneration as number;
    const oldChild = (manager as any).startTunnelProcess() as FakeChildProcess;
    const oldStartup = (manager as any).waitForTunnelStartup(oldChild, oldGeneration) as Promise<void>;

    (manager as any).tunnelGeneration += 1;
    const replacement = (manager as any).startTunnelProcess() as FakeChildProcess;
    (manager as any).domain = "current-generation.trycloudflare.com";
    oldChild.emitStdout("INF +https://stale-generation.trycloudflare.com ready\n");

    await assert.rejects(oldStartup, /cancelled by a newer lifecycle operation/i);
    assert.equal((manager as any).domain, "current-generation.trycloudflare.com");
    assert.equal((manager as any).tunnelProcess, replacement);
    oldChild.emitClose(null, "SIGTERM");
  } finally {
    await manager.stop();
  }
});

test("Windows taskkill fallback cannot directly kill the same tunnel twice", { skip: process.platform !== "win32" }, async () => {
  const manager = makeManager("cloudflare-named");
  const taskkill = deferred<{ stdout: string }>();
  childProcessTest.setExecHandler((command) => {
    if (command.toLowerCase().includes("taskkill")) return taskkill.promise;
    return { stdout: "ok\n" };
  });
  await manager.initialize();
  (manager as any).localPort = 41000;
  const child = (manager as any).startTunnelProcess() as FakeChildProcess;
  child.autoExitOnKill = false;
  try {
    assert.equal(await (manager as any).terminateTunnelProcess(child, 5), false);
    assert.equal(child.killCalls, 1, "the bounded timeout performs the sole direct fallback kill");
    taskkill.reject(new Error("simulated late taskkill failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(child.killCalls, 1, "the late taskkill failure must observe the existing kill and remain a no-op");
  } finally {
    taskkill.reject(new Error("simulated late taskkill failure"));
    child.emitExit(null, "SIGTERM");
    await manager.stop();
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

test("cloudflare-named: failed-start cleanup, Stop, and restart share one teardown transaction", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    await startManager(manager, "cloudflare-named", 0, "serialized-cleanup");
    const oldServer = httpTest.servers[0]!;
    httpTest.setAutoCompleteClose(false);

    const failedStartCleanup = (manager as any).stopResources(false) as Promise<void>;
    await waitFor(() => !oldServer.listening, "old HTTP server close request");
    assert.equal(manager.getStatus().publicHealthAvailable, false, "teardown must stop advertising the public endpoint immediately");
    let stopFinished = false;
    const stop = manager.stop().then((status) => {
      stopFinished = true;
      return status;
    });
    const restart = manager.start(undefined, { automaticCheck: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopFinished, false);
    assert.equal(childProcessTest.spawned.length, 1, "restart must wait for the failed-start cleanup owner");

    oldServer.completeClose();
    await failedStartCleanup;
    const stopped = await stop;
    assert.equal(stopped.state, "stopped", "a concurrent user Stop upgrades the shared cleanup to stopped state");

    await waitFor(() => childProcessTest.spawned.length === 2, "replacement after serialized cleanup");
    startupSignal("cloudflare-named", childProcessTest.spawned[1]!, "after-cleanup");
    const restarted = await restart;
    assert.equal(restarted.state, "running");
    assert.equal(restarted.publicHealthAvailable, true);
    assert.ok(restarted.localPort, "old cleanup must not erase the replacement local port");
    assert.equal(restarted.domain, NAMED_DOMAIN);
  } finally {
    httpTest.setAutoCompleteClose(true);
    await manager.stop();
    for (const server of httpTest.servers) server.completeClose();
    globalThis.fetch = originalFetch;
  }
});

test("development local smoke cannot restore running state after a concurrent Stop", async () => {
  const previousSmokeFlag = process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL;
  process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL = "1";
  const manager = makeManager("cloudflare", 2);
  httpTest.setAutoCompleteListen(false);
  try {
    await manager.initialize();
    const smokeStart = manager.startLocalSmoke();
    const duplicateSmokeStart = manager.startLocalSmoke();
    await waitFor(() => httpTest.servers.length === 1, "local smoke HTTP server");
    const server = httpTest.servers[0]!;
    assert.equal(server.listening, false, "the fake must preserve the real pre-listen Stop window");
    assert.equal(httpTest.servers.length, 1, "concurrent smoke starts must share one HTTP server");
    const stop = manager.stop();
    await waitFor(() => !server.listening, "local smoke Stop close");
    server.completeListen();

    const [startResult, duplicateResult, stopResult] = await Promise.all([smokeStart, duplicateSmokeStart, stop]);
    assert.equal(startResult.state, "stopped");
    assert.equal(duplicateResult.state, "stopped");
    assert.equal(stopResult.state, "stopped");
    assert.equal(manager.getStatus().localPort, undefined);
  } finally {
    httpTest.setAutoCompleteListen(true);
    for (const server of httpTest.servers) {
      server.completeListen();
      server.completeClose();
    }
    await manager.stop();
    if (previousSmokeFlag === undefined) delete process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL;
    else process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL = previousSmokeFlag;
  }
});

test("a listener error is cleaned up immediately instead of waiting for the pre-listen shutdown timeout", async () => {
  const previousSmokeFlag = process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL;
  process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL = "1";
  const manager = makeManager("cloudflare", 2);
  httpTest.setAutoCompleteListen(false);
  try {
    await manager.initialize();
    const smokeStart = manager.startLocalSmoke();
    await waitFor(() => httpTest.servers.length === 1, "local smoke listener awaiting an error");
    const error = Object.assign(new Error("simulated address in use"), { code: "EADDRINUSE" });
    httpTest.servers[0]!.failListen(error);
    await assert.rejects(
      Promise.race([
        smokeStart,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("listener cleanup waited for the 3 second shutdown timeout")), 250)),
      ]),
      /simulated address in use/,
    );
  } finally {
    httpTest.setAutoCompleteListen(true);
    await manager.stop();
    if (previousSmokeFlag === undefined) delete process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL;
    else process.env.AGENTBRIDGE_BRIDGE_SMOKE_LOCAL = previousSmokeFlag;
  }
});

test("cloudflare: Stop aborts an old automatic tunnel check before a new Start checks again", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
  const oldCheck = deferred<{ stdout: string }>();
  let execCalls = 0;
  const manager = makeManager("cloudflare");
  childProcessTest.setExecHandler(async (command, args) => {
    if (command.toLowerCase().includes("cloudflared") && args.includes("--version")) {
      execCalls += 1;
      if (execCalls === 1) return oldCheck.promise;
      return { stdout: "cloudflared version 2099.1.0\n" };
    }
    if (command.toLowerCase().includes("taskkill")) {
      const pidIndex = args.findIndex((value) => value.toUpperCase() === "/PID");
      const child = childProcessTest.spawned.find((candidate) => candidate.pid === Number(args[pidIndex + 1]));
      child?.kill();
      return { stdout: "SUCCESS\n" };
    }
    return { stdout: "ok\n" };
  });
  try {
    await manager.initialize();
    const firstStart = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => execCalls === 1, "old automatic tunnel check");
    let stopFinished = false;
    const stop = manager.stop().then((status) => {
      stopFinished = true;
      return status;
    });
    const restart = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => stopFinished, "aborted tunnel check Stop completion");
    await stop;
    await firstStart;
    await waitFor(() => execCalls >= 2, "new generation tunnel check");
    await waitFor(() => childProcessTest.spawned.length === 1, "new generation tunnel spawn");
    startupSignal("cloudflare", childProcessTest.spawned[0]!, "new-check");
    const restarted = await restart;
    assert.equal(restarted.state, "running");
    assert.ok(execCalls >= 2);
    oldCheck.resolve({ stdout: "cloudflared version 2098.1.0\n" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.getStatus().state, "running", "late output from the aborted check must not overwrite the new generation");
  } finally {
    oldCheck.resolve({ stdout: "cloudflared version 2098.1.0\n" });
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: Stop cancels a pending recovery backoff immediately", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    await startManager(manager, "cloudflare-named", 0, "recovery-backoff");
    childProcessTest.spawned[0]!.emitExit(1, null);
    await waitFor(() => Boolean((manager as any).tunnelRecoveryAbort), "pending recovery backoff");

    await manager.stop();
    await waitFor(() => !(manager as any).tunnelRecoveryPromise, "cancelled recovery completion");
    assert.equal((manager as any).tunnelRecoveryAbort, undefined);
    assert.equal(childProcessTest.spawned.length, 1, "cancelled backoff must not spawn a recovery tunnel");
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: continuous public health distinguishes fluctuation, outage, and recovery", async () => {
  const originalFetch = globalThis.fetch;
  let publicHealthy = true;
  globalThis.fetch = (async () => healthyResponse(publicHealthy)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const initial = await startManager(manager, "cloudflare-named", 0, "health-monitor");
    assert.equal(initial.state, "running");
    assert.equal(initial.publicHealthState, "healthy");
    assert.equal(initial.publicHealthAvailable, true);
    assert.equal(initial.publicHealthAutomatic, true);
    assert.equal(initial.publicHealthFailureCount, 0);
    assert.ok(initial.publicHealthLastSuccessAt);
    assert.ok((manager as any).publicHealthMonitorTimer, "a successful start schedules continuous public-health monitoring");

    publicHealthy = false;
    const unstable = await manager.checkPublicHealth();
    assert.equal(unstable.state, "running", "a single public failure must not stop the local Bridge");
    assert.equal(unstable.publicHealthState, "unstable");
    assert.equal(unstable.publicHealthFailureCount, 1);
    assert.ok(unstable.publicHealthError);

    const unhealthy = await manager.checkPublicHealth();
    assert.equal(unhealthy.state, "running");
    assert.equal(unhealthy.publicHealthState, "unhealthy");
    assert.equal(unhealthy.publicHealthFailureCount, 2);
    assert.ok(unhealthy.publicHealthLastSuccessAt, "the last successful public check remains visible during an outage");

    publicHealthy = true;
    const recovered = await manager.checkPublicHealth();
    assert.equal(recovered.publicHealthState, "healthy");
    assert.equal(recovered.publicHealthFailureCount, 0);
    assert.equal(recovered.publicHealthError, undefined);

    const stopped = await manager.stop();
    assert.equal(stopped.publicHealthState, "inactive");
    assert.equal(stopped.publicHealthLastCheckedAt, undefined);
    assert.equal(stopped.publicHealthLastSuccessAt, undefined);
    assert.equal((manager as any).publicHealthMonitorTimer, undefined, "Stop clears the public-health timer");
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: automatic public health timer performs a real follow-up check", async () => {
  const originalFetch = globalThis.fetch;
  const timers = installControlledPublicHealthTimers();
  let publicHealthy = true;
  globalThis.fetch = (async () => healthyResponse(publicHealthy)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    const initial = await startManager(manager, "cloudflare-named", 0, "automatic-health");
    assert.equal(initial.publicHealthState, "healthy");
    assert.equal(timers.pendingCount(), 1, "Cloudflare starts one automatic monitor timer");

    publicHealthy = false;
    timers.fireNext();
    await waitFor(() => manager.getStatus().publicHealthFailureCount === 1, "automatic public-health failure");
    assert.equal(manager.getStatus().publicHealthState, "unstable");
    assert.equal(timers.pendingCount(), 1, "the completed check schedules its next monitor timer");

    await manager.stop();
    assert.equal(timers.pendingCount(), 0, "Stop clears the automatic monitor timer");
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
    timers.restore();
  }
});

test("cloudflare-named: the monitor budget is a hard deadline and ignores a late healthy result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  const lateHealth = deferred<any>();
  let budgetTimers: ReturnType<typeof installControlledPublicHealthTimers> | undefined;
  try {
    await manager.initialize();
    await startManager(manager, "cloudflare-named", 0, "hard-budget");
    budgetTimers = installControlledPublicHealthTimers(8_000);
    globalThis.fetch = (async () => lateHealth.promise) as typeof fetch;

    const check = manager.checkPublicHealth();
    await waitFor(() => budgetTimers!.pendingCount() === 1, "public-health budget timer");
    budgetTimers.fireNext();
    const timedOut = await check;
    assert.equal(timedOut.publicHealthState, "unstable");
    assert.match(timedOut.publicHealthError ?? "", /8/);
    assert.equal(timedOut.publicHealthChecking, false);

    lateHealth.resolve(healthyResponse(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.getStatus().publicHealthState, "unstable", "a healthy result arriving after the deadline must be ignored");
  } finally {
    lateHealth.resolve(healthyResponse(true));
    budgetTimers?.restore();
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: stale health completion after Stop and restart cannot clear the new monitor", async () => {
  const originalFetch = globalThis.fetch;
  const timers = installControlledPublicHealthTimers();
  const pendingOldHealth = deferred<any>();
  let holdOldCheck = false;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return holdOldCheck ? pendingOldHealth.promise : healthyResponse(true);
  }) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    await startManager(manager, "cloudflare-named", 0, "old-generation");
    const oldGeneration = (manager as any).tunnelGeneration as number;
    holdOldCheck = true;
    const oldCheck = (manager as any).runPublicHealthMonitorCheck(oldGeneration) as Promise<void>;
    const oldTail = oldCheck.finally(() => (manager as any).schedulePublicHealthMonitor(oldGeneration));
    await waitFor(() => manager.getStatus().publicHealthChecking, "old public-health check");

    await manager.stop();
    holdOldCheck = false;
    const restart = manager.start(undefined, { automaticCheck: true });
    await waitFor(() => childProcessTest.spawned.length === 2, "replacement tunnel spawn");
    startupSignal("cloudflare-named", childProcessTest.spawned[1]!, "new-generation");
    const restarted = await restart;
    assert.equal(restarted.publicHealthState, "healthy");
    assert.equal(timers.pendingCount(), 1);
    const newTimer = (manager as any).publicHealthMonitorTimer;

    pendingOldHealth.resolve(healthyResponse(false));
    await oldTail;
    assert.equal((manager as any).publicHealthMonitorTimer, newTimer, "old completion must leave the new generation timer untouched");
    assert.equal(timers.pendingCount(), 1);

    const beforeManualCheck = fetchCalls;
    const checked = await manager.checkPublicHealth();
    assert.equal(checked.publicHealthState, "healthy");
    assert.ok(fetchCalls > beforeManualCheck, "the new generation must not reuse the detached old Promise");
  } finally {
    pendingOldHealth.resolve(healthyResponse(false));
    await manager.stop();
    globalThis.fetch = originalFetch;
    timers.restore();
  }
});

test("ngrok: startup and manual public health work without background quota polling", async () => {
  const originalFetch = globalThis.fetch;
  let publicHealthy = true;
  globalThis.fetch = (async () => healthyResponse(publicHealthy)) as typeof fetch;
  const manager = makeManager("ngrok");
  try {
    await manager.initialize();
    const initial = await startManager(manager, "ngrok", 0, "manual-health");
    assert.equal(initial.publicHealthState, "healthy");
    assert.equal(initial.publicHealthAvailable, true);
    assert.equal(initial.publicHealthAutomatic, false);
    assert.equal((manager as any).publicHealthMonitorTimer, undefined, "ngrok must not spend quota on idle background checks");

    publicHealthy = false;
    const checked = await manager.checkPublicHealth();
    assert.equal(checked.publicHealthState, "unstable");
    assert.equal(checked.publicHealthFailureCount, 1);
    assert.equal((manager as any).publicHealthMonitorTimer, undefined);
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("ngrok: a non-success HTTP response with a hanging body cancel still settles promptly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
  const manager = makeManager("ngrok");
  let cancelCalls = 0;
  let requestWasAborted = false;
  try {
    await manager.initialize();
    await startManager(manager, "ngrok", 0, "hanging-body");
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      init?.signal?.addEventListener("abort", () => { requestWasAborted = true; }, { once: true });
      return {
        ok: false,
        status: 502,
        body: {
          cancel: () => {
            cancelCalls += 1;
            return new Promise<void>(() => undefined);
          },
        },
      };
    }) as unknown as typeof fetch;
    const result = await Promise.race([
      manager.checkPublicHealth(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("health check waited for body.cancel")), 250)),
    ]);
    assert.equal(result.publicHealthState, "unstable");
    assert.equal(cancelCalls, 1);
    assert.equal(requestWasAborted, true, "the per-request controller must release the failed response even if body.cancel hangs");
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cloudflare-named: a close-only tunnel lifecycle is not reported as publicly available", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => healthyResponse(true)) as typeof fetch;
  const manager = makeManager("cloudflare-named");
  try {
    await manager.initialize();
    await startManager(manager, "cloudflare-named", 0, "close-only");
    childProcessTest.spawned[0]!.emitClose(null, null);
    assert.equal(manager.getStatus().state, "starting", "close-only must enter recovery instead of leaving a dead running state");
    assert.equal(manager.getStatus().publicHealthAvailable, false);
    await waitFor(() => Boolean((manager as any).tunnelRecoveryAbort), "close-only recovery backoff");
    await assert.rejects(() => manager.checkPublicHealth(), /Start the Bridge before checking the public endpoint/i);
  } finally {
    await manager.stop();
    globalThis.fetch = originalFetch;
  }
});

test("public-health fetches do not follow redirects", async () => {
  const originalFetch = globalThis.fetch;
  const manager = makeManager("cloudflare-named");
  const redirects: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    redirects.push(init?.redirect);
    return {
      ok: false,
      status: 302,
      body: { cancel: async () => undefined },
    } as any;
  }) as typeof fetch;
  try {
    await manager.initialize();
    (manager as any).domain = NAMED_DOMAIN;
    assert.equal(await (manager as any).requestPublicHealth(() => undefined), false);
    assert.equal(await (manager as any).resolveHostViaDoh(NAMED_DOMAIN, undefined, true), null);
    assert.ok(redirects.length >= 3, "the public endpoint and both DoH endpoints should be exercised");
    assert.deepEqual(new Set(redirects), new Set(["manual"]), "neither route-token health requests nor DoH lookups may follow redirects");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DoH direct health response and request failures all settle false", async () => {
  const manager = makeManager("cloudflare-named");
  const reports: string[] = [];
  try {
    await manager.initialize();
    for (const mode of ["redirect", "aborted", "error", "close", "request-error", "request-close", "throw", "end-throw"] as const) {
      httpsTest.setResponseMode(mode);
      const result = await (manager as any).sendPublicHealthRequest(
        NAMED_DOMAIN,
        "203.0.113.1",
        (message: string) => reports.push(message),
      );
      assert.equal(result, false, `${mode} response must settle as unhealthy`);
      if (mode === "redirect") assert.equal(httpsTest.destroyCount, 1, "a non-2xx response must destroy the underlying HTTPS request");
    }
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const requestsBeforeAbort = httpsTest.requestCount;
    const abortedBeforeRequest = await (manager as any).sendPublicHealthRequest(
      NAMED_DOMAIN,
      "203.0.113.1",
      (message: string) => reports.push(message),
      alreadyAborted.signal,
    );
    assert.equal(abortedBeforeRequest, false);
    assert.equal(httpsTest.requestCount, requestsBeforeAbort, "an already-aborted signal must not create an HTTPS request");
  } finally {
    httpsTest.reset();
  }
  assert.ok(reports.some((message) => message.includes("aborted")));
  assert.ok(reports.some((message) => message.includes("simulated response error")));
  assert.ok(reports.some((message) => message.includes("closed before completion")));
  assert.ok(reports.some((message) => message.includes("simulated request error")));
  assert.ok(reports.some((message) => message.includes("closed before receiving a response")));
  assert.ok(reports.some((message) => message.includes("simulated synchronous request failure")));
  assert.ok(reports.some((message) => message.includes("simulated request end failure")));
});

test("DoH accepts only public IPv4 answers and scopes its cache to the tunnel generation", async () => {
  const originalFetch = globalThis.fetch;
  const manager = makeManager("cloudflare-named");
  let answer = "127.0.0.1";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ Answer: [{ type: 1, data: answer }] }),
    } as any;
  }) as typeof fetch;
  try {
    await manager.initialize();
    for (const specialUse of ["127.0.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.51.100.1", "203.0.113.1"]) {
      answer = specialUse;
      const rejected = await (manager as any).resolveHostViaDoh(NAMED_DOMAIN, undefined, true);
      assert.equal(rejected, null, `${specialUse} must not become a direct HTTPS target`);
    }

    answer = "104.16.1.1";
    const publicIp = await (manager as any).resolveHostViaDoh(NAMED_DOMAIN);
    assert.equal(publicIp, answer);
    const cachedAtCalls = calls;
    assert.equal(await (manager as any).resolveHostViaDoh(NAMED_DOMAIN), answer);
    assert.equal(calls, cachedAtCalls, "same-generation lookup should use the short-lived cache");

    (manager as any).tunnelGeneration += 1;
    assert.equal(await (manager as any).resolveHostViaDoh(NAMED_DOMAIN), answer);
    assert.ok(calls > cachedAtCalls, "a new tunnel generation must not reuse the old DNS cache entry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
