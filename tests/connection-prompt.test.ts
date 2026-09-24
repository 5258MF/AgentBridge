import assert from "node:assert/strict";
import test from "node:test";
import { enMessages, zhMessages } from "../src/extension/src/i18n.js";

// The copied connection prompt only explains how to connect; server instructions and tool
// descriptions cover the rest. These checks pin the agreed content so it cannot silently drift.
for (const [lang, prompt] of [["zh", zhMessages.connectionPrompt], ["en", enMessages.connectionPrompt]] as const) {
  test(`connection prompt (${lang}) keeps the agreed essentials`, () => {
    for (const required of [
      "Streamable HTTP",
      "a. ", "b. ", "c. ",
      "Accept: application/json, text/event-stream",
      "Content-Type: application/json",
      "2025-11-25",
      "notifications/initialized",
      "tools/list",
      "Mcp-Session-Id",
      "404",
    ]) {
      assert.ok(prompt.includes(required), `${lang} prompt is missing ${JSON.stringify(required)}`);
    }
    assert.ok(prompt.split("\n").length <= 20, `${lang} prompt should stay short`);
  });
}

test("connection prompt allows reusing the session id and keeps the URL out of code", () => {
  assert.match(zhMessages.connectionPrompt, /后续请求一直复用/);
  assert.match(zhMessages.connectionPrompt, /你自己环境的临时文件/);
  assert.match(zhMessages.connectionPrompt, /不要把 URL 写进代码或仓库/);
  assert.match(enMessages.connectionPrompt, /reuse it on every later request/);
  assert.match(enMessages.connectionPrompt, /temporary file in your own environment/);
  assert.match(enMessages.connectionPrompt, /Do not write the URL into code or a repository/);
});

test("connection prompt has the same shape in both languages", () => {
  assert.equal(zhMessages.connectionPrompt.split("\n").length, enMessages.connectionPrompt.split("\n").length);
});
