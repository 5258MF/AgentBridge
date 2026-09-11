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
    child.emitStdout("INF Registered tunnel connection connIndex=0\n");
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
    if ([750, 1000, 2000, 4000, 8000, 15000].includes(Number(delay))) {
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
