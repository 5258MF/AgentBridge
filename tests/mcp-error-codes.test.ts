import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { McpParseError, McpRequestTooLargeError, JSON_RPC_PARSE_ERROR, jsonRpcErrorCode, readJsonBody } from "../src/extension/src/bridge-server.js";

function fakeRequest(): any {
  const request: any = new EventEmitter();
  request.destroyed = false;
  request.destroy = () => {
    request.destroyed = true;
  };
  request.paused = false;
  request.pause = () => {
    request.paused = true;
  };
  return request;
}

test("a malformed body maps to the JSON-RPC parse error", () => {
  assert.equal(jsonRpcErrorCode(new McpParseError(), 500), JSON_RPC_PARSE_ERROR);
  assert.equal(jsonRpcErrorCode(new McpParseError(), 500), -32700);
});

test("a parse error is reported as a client error, not a server error", () => {
  const error = new McpParseError();
  assert.equal(error.status, 400);
  assert.match(error.message, /not valid JSON/);
});

test("other failures keep their existing codes", () => {
  assert.equal(jsonRpcErrorCode(new Error("boom"), 404), -32004);
  assert.equal(jsonRpcErrorCode(new Error("boom"), 500), -32000);
  assert.equal(jsonRpcErrorCode(undefined, 500), -32000);
});

test("an oversized body is a client error with its own status", () => {
  const error = new McpRequestTooLargeError(8 * 1024 * 1024);
  assert.equal(error.status, 413);
  assert.match(error.message, /exceeds 8388608 bytes/);
  assert.equal(jsonRpcErrorCode(error, error.status), -32000);
});

test("an oversized body is rejected without closing the socket first", async () => {
  // readJsonBody used to destroy the request on the spot. The caller then wrote its error
  // into a socket that was already gone, so the client saw a connection reset instead of
  // the 413 that would have told it what was wrong.
  const request = fakeRequest();
  const pending = readJsonBody(request);
  request.emit("data", Buffer.alloc(6 * 1024 * 1024, 0x61));
  request.emit("data", Buffer.alloc(6 * 1024 * 1024, 0x61));
  await assert.rejects(pending, (error: unknown) => error instanceof McpRequestTooLargeError);
  assert.equal(request.destroyed, false, "the caller must still be able to answer");
});

test("an oversized body is read to the end, so the client can finish sending and read the 413", async () => {
  // Draining is the other half of not destroying the socket, and it is the half that was
  // missing: a client cannot read the response until it has finished writing, and a body the
  // server stops reading never lets that write finish. A real 9 MiB request against the bridge
  // came back as an SSL EOF with no status at all, which is what this pins down. The stub used
  // to answer pause() with undefined, so the test could not see the difference.
  const request = fakeRequest();
  const pending = readJsonBody(request);
  const megabyte = Buffer.alloc(1024 * 1024, 0x61);
  for (let index = 0; index < 9; index += 1) request.emit("data", megabyte);
  assert.equal(request.paused, false, "the reader stopped reading while the client was still sending");
  assert.equal(request.destroyed, false, "the caller must still be able to answer");
  request.emit("end");
  await assert.rejects(pending, (error: unknown) => error instanceof McpRequestTooLargeError);
});

test("a body within the limit is parsed", async () => {
  const request = fakeRequest();
  const pending = readJsonBody(request);
  request.emit("data", Buffer.from('{"ok":true}', "utf8"));
  request.emit("end");
  assert.deepEqual(await pending, { ok: true });
});

test("an empty body is a parse error, not a missing initialize request", async () => {
  // The old code resolved an empty body to undefined and let it reach isInitializeRequest,
  // which answered with a message about initialize requests rather than about the body that
  // was never sent.
  const request = fakeRequest();
  const pending = readJsonBody(request);
  request.emit("end");
  await assert.rejects(pending, (error: unknown) => error instanceof McpParseError);
});

test("a body that is not valid UTF-8 is a parse error", async () => {
  // Decoding with Buffer.toString("utf8") would replace the bad byte with U+FFFD and hand the
  // caller a string that parses, so a truncated multi-byte character silently changed meaning.
  const body = Buffer.concat([Buffer.from('{"a":"', "utf8"), Buffer.from([0xc3]), Buffer.from('"}', "utf8")]);
  const request = fakeRequest();
  const pending = readJsonBody(request);
  request.emit("data", body);
  request.emit("end");
  await assert.rejects(pending, (error: unknown) => error instanceof McpParseError);
});

test("a valid multi-byte body survives being split across chunks", async () => {
  // Strict decoding runs on the concatenated buffer, so a character split by a chunk boundary
  // still decodes instead of being reported as invalid.
  const bytes = Buffer.from('{"a":"你好"}', "utf8");
  const request = fakeRequest();
  const pending = readJsonBody(request);
  request.emit("data", bytes.subarray(0, 8));
  request.emit("data", bytes.subarray(8));
  request.emit("end");
  assert.deepEqual(await pending, { a: "你好" });
});
