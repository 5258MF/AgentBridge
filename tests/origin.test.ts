import test from "node:test";
import assert from "node:assert/strict";
import { constantTimeStringEqual, normalizeTrustedBrowserOrigin } from "../src/extension/src/bridge-server.js";

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

test("constantTimeStringEqual matches only identical strings", () => {
  const endpoint = "/mcp/0123456789abcdef0123456789abcdef";
  assert.equal(constantTimeStringEqual(endpoint, endpoint), true);
  assert.equal(constantTimeStringEqual("", ""), true);
  assert.equal(constantTimeStringEqual(endpoint, "/mcp/0123456789abcdef0123456789abcdee"), false);
  assert.equal(constantTimeStringEqual(endpoint, "/mcp/0123456789abcdef"), false);
  assert.equal(constantTimeStringEqual(endpoint, `${endpoint}/`), false);
  assert.equal(constantTimeStringEqual(endpoint, endpoint.toUpperCase()), false);
  assert.equal(constantTimeStringEqual(endpoint, ""), false);
});
