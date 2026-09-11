import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTrustedBrowserOrigin } from "../src/extension/src/bridge-server.js";

test("normalizeTrustedBrowserOrigin accepts exact canonical origins", () => {
  const accepted = [
    "http://localhost",
    "http://localhost:3000",
    "https://example.com",
    "https://example.com:8443",
    "chrome-extension://abcdefghijklmnop",
    "moz-extension://12345678-abcd-4321-bbbb-abcdefabcdef",
    "http://[::1]",
    "http://[::1]:3000",
  ];
  for (const origin of accepted) {
    assert.equal(normalizeTrustedBrowserOrigin(origin), origin, origin);
  }
});

test("normalizeTrustedBrowserOrigin rejects non-canonical and unsafe forms", () => {
  const rejected = [
    "",
    "not a url",
    "*",
    "https://*.example.com",
    "https://example.com/path",
    "https://example.com/foo/..",
    "https://example.com?",
    "https://example.com#",
    "https://user:pass@example.com",
    "ftp://example.com",
    "https:example.com",
    "https://example.com/",
    "https://example.com:443",
    "https://EXAMPLE.com",
    "https://example.com/?x=1",
    "https://example.com/#fragment",
    "chrome-extension://ABCDEF",
  ];
  for (const origin of rejected) {
    assert.equal(normalizeTrustedBrowserOrigin(origin), undefined, origin);
  }
});
