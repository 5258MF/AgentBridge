import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_EVENT_STORE_MAX_BYTES, BoundedInMemoryEventStore } from "../src/extension/src/http-helpers.js";
import { dropRetainedOutputBefore, trimSettledOutput, type RetainedOutput } from "../src/extension/src/ide-tool-broker.js";

function retained(chunks: string[]): RetainedOutput {
  const buffers = chunks.map((chunk) => Buffer.from(chunk, "utf8"));
  const starts: number[] = [];
  let total = 0;
  for (const buffer of buffers) {
    starts.push(total);
    total += buffer.length;
  }
  return {
    outputChunks: buffers,
    outputChunkStarts: starts,
    outputChunkHead: 0,
    outputHeadSkip: 0,
    retainedOutputBytes: total,
    outputStartOffset: 0,
    totalOutputBytes: total,
  };
}

function text(output: RetainedOutput): string {
  const live = output.outputChunks.slice(output.outputChunkHead);
  return Buffer.concat(live).subarray(output.outputHeadSkip).toString("utf8");
}

test("dropRetainedOutputBefore releases whole chunks and copies a partly dropped head", () => {
  const output = retained(["aaaa", "bbbb", "cccc"]);
  dropRetainedOutputBefore(output, 6, true);
  assert.equal(text(output), "bbcccc");
  assert.equal(output.outputStartOffset, 6);
  assert.equal(output.retainedOutputBytes, 6);
  assert.equal(output.outputChunkHead, 0, "dropped chunks are compacted away");
  assert.equal(output.outputHeadSkip, 0, "the partial head is copied, not referenced");
  assert.deepEqual(output.outputChunkStarts, [6, 8]);
  assert.equal(output.outputChunks[0].toString(), "bb");
});

test("dropRetainedOutputBefore never moves backwards or past the end", () => {
  const output = retained(["abc"]);
  dropRetainedOutputBefore(output, 2);
  dropRetainedOutputBefore(output, 1);
  assert.equal(output.outputStartOffset, 2);
  dropRetainedOutputBefore(output, 99);
  assert.equal(output.outputStartOffset, 3);
  assert.equal(output.retainedOutputBytes, 0);
});

test("trimSettledOutput keeps unread bytes and otherwise only the settled tail", () => {
  const unread = retained(["0123456789"]);
  trimSettledOutput(unread, 0, 4);
  assert.equal(text(unread), "0123456789", "nothing delivered yet, nothing dropped");

  const partlyRead = retained(["0123456789"]);
  trimSettledOutput(partlyRead, 3, 4);
  assert.equal(text(partlyRead), "3456789");

  const fullyRead = retained(["0123456789"]);
  trimSettledOutput(fullyRead, 10, 4);
  assert.equal(text(fullyRead), "6789");
  assert.equal(fullyRead.outputStartOffset, 6);
});

test("per-session replay events are capped at 2 MiB", async () => {
  assert.equal(SESSION_EVENT_STORE_MAX_BYTES, 2 * 1024 * 1024);
  const store = new BoundedInMemoryEventStore();
  const payload = "z".repeat(700 * 1024);
  const ids: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    ids.push(await store.storeEvent("stream-1", { jsonrpc: "2.0", id: index, result: { payload } } as any));
  }
  assert.equal(await store.getStreamIdForEventId(ids[0]), undefined, "the oldest event is evicted once the cap is exceeded");
  assert.equal(await store.getStreamIdForEventId(ids[3]), "stream-1");
});
