import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { enMessages, invalidateTranslator, translate, zhMessages } from "../src/extension/src/i18n.js";
import { vscodeTest } from "./helpers/fake-vscode.js";

const srcDir = path.join(process.cwd(), "src", "extension", "src");

function sourceTexts(): string {
  return fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts") && name !== "i18n.ts")
    .map((name) => fs.readFileSync(path.join(srcDir, name), "utf8"))
    .join("\n");
}

test("the two catalogs hold the same keys", () => {
  // enMessages is typed as Record<MessageKey, string>, so a missing key is a compile error
  // and a surplus one is not. Compared here as well because the failure is otherwise silent:
  // an extra English entry is simply never read.
  assert.deepEqual(Object.keys(enMessages).sort(), Object.keys(zhMessages).sort());
});

test("every message is reachable from somewhere in the extension", () => {
  // A key nothing references is text nobody will ever read, and it still has to be kept in
  // step with the other language. Four such keys had accumulated, one of them a duplicate of
  // another entry with a different name.
  const sources = sourceTexts();
  const unused = Object.keys(zhMessages).filter(
    (key) => !sources.includes(`"${key}"`) && !sources.includes(`'${key}'`),
  );
  assert.deepEqual(unused, [], `unused i18n keys: ${unused.join(", ")}`);
});

test("a Chinese message uses Chinese punctuation", () => {
  // A half-width comma or colon inside a Chinese sentence is a visible slip: the rest of the
  // catalog uses the full-width forms, and one block that did not read as an older draft left
  // sitting next to the newer text. Only flagged next to a CJK character, because a Windows
  // path such as C:\\... or a tool name is legitimately written with them.
  const halfWidth = /[,:;?!]/;
  const cjkContext = /[　-〿一-鿿＀-￯]/;
  for (const [key, value] of Object.entries(zhMessages)) {
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]!;
      if (!halfWidth.test(character)) continue;
      const around = `${value[index - 1] ?? ""}${value[index + 1] ?? ""}`;
      assert.ok(
        !cjkContext.test(around),
        `zh.${key} writes ${JSON.stringify(character)} next to Chinese text: ${value.slice(Math.max(0, index - 20), index + 20)}`,
      );
    }
  }
});

test("no message carries an HTML entity", () => {
  // The catalogs are described as plain strings, and that is what most consumers treat them
  // as - textContent and error messages among them. One entry stored "&lt;port&gt;" instead,
  // which only read as "<port>" because that one insertion point skipped escaping; anywhere
  // else it is shown literally, and escaping it there would have shown it escaped.
  const entity = /&(?:lt|gt|amp|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/i;
  for (const [catalog, messages] of [["zh", zhMessages], ["en", enMessages]] as const) {
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(!entity.test(value), `${catalog}.${key} holds an HTML entity: ${value}`);
    }
  }
});

test("a message is translated once, and a change to the setting is told about", () => {
  // Every message used to read the language setting and then build a translator over the whole
  // catalogue again, and the panel and the activity log translate once per entry they show. The
  // language is decided once now, so the one thing that has to work is the invalidation: a
  // change to the setting has to reach it, or the panel would go on answering in the language
  // it started in.
  vscodeTest.reset();
  vscodeTest.setConfig("agentbridge.language", "en");
  invalidateTranslator();
  assert.equal(translate("copy"), enMessages.copy);
  assert.equal(translate("copy"), enMessages.copy, "the same answer twice, without reading the setting again");

  vscodeTest.setConfig("agentbridge.language", "zh-CN");
  assert.equal(translate("copy"), enMessages.copy, "the cached translator is still the one in use");
  invalidateTranslator();
  assert.equal(translate("copy"), zhMessages.copy, "and the setting is read again once told to be");

  vscodeTest.setConfig("agentbridge.language", "en");
  invalidateTranslator();
});
