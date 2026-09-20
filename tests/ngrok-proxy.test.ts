import test from "node:test";
import assert from "node:assert/strict";
import { isNgrokProxyRejection, withoutProxyVariables } from "../src/extension/src/bridge-server.js";

test("proxy variables are stripped before ngrok is spawned", () => {
  const stripped = withoutProxyVariables({
    PATH: "C:\\bin",
    HTTPS_PROXY: "http://proxy:8080",
    https_proxy: "http://proxy:8080",
    HTTP_PROXY: "http://proxy:8080",
    http_proxy: "http://proxy:8080",
    ALL_PROXY: "socks5://proxy:1080",
    all_proxy: "socks5://proxy:1080",
  });
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    assert.equal(key in stripped, false, key);
  }
});

test("variables that merely mention a proxy are left alone", () => {
  const stripped = withoutProxyVariables({
    PATH: "C:\\bin",
    MY_PROXY_CONFIG: "custom",
    PROXY_HOST: "proxy.example",
  });
  assert.equal(stripped.PATH, "C:\\bin");
  assert.equal(stripped.MY_PROXY_CONFIG, "custom");
  assert.equal(stripped.PROXY_HOST, "proxy.example");
});

test("the input environment is not mutated", () => {
  const original: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://proxy:8080" };
  withoutProxyVariables(original);
  assert.equal(original.HTTPS_PROXY, "http://proxy:8080");
});

test("the Free-plan proxy rejection is recognised", () => {
  assert.equal(isNgrokProxyRejection("lvl=eror msg=\"ERR_NGROK_9009\""), true);
  assert.equal(isNgrokProxyRejection("your account is on the Pay-as-you-go plan"), true);
});

test("other ngrok failures are not mistaken for the proxy rejection", () => {
  assert.equal(isNgrokProxyRejection("lvl=eror msg=\"ERR_NGROK_108\""), false);
  assert.equal(isNgrokProxyRejection("endpoint is already online"), false);
  assert.equal(isNgrokProxyRejection("failed to start tunnel"), false);
});

test("the bypass list goes with the proxy it belongs to", () => {
  const stripped = withoutProxyVariables({
    HTTPS_PROXY: "http://proxy:8080",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  });
  assert.equal("NO_PROXY" in stripped, false);
  assert.equal("no_proxy" in stripped, false);
});
