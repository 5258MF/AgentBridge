import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_TOOL_DEFINITIONS,
  buildReadOnlySessionNotice,
  buildReadOnlyTransitionNotice,
  buildServerInstructions,
  planModeBlockError,
  READ_ONLY_BLOCKED_TOOL_NAMES,
} from "../src/extension/src/bridge-server.js";
import { enMessages, zhMessages } from "../src/extension/src/i18n.js";

/**
 * Model-facing prose (server instructions and read-only notices) is hand-written and names
 * tools inline. This guards it against tool renames/removals: every tool-like identifier it
 * mentions must exist in the live tool definitions.
 */

const TOOL_NAMES = new Set<string>(BRIDGE_TOOL_DEFINITIONS.map((tool) => tool.name));

/** Parameter names and enum values from the live input schemas (wait_ms, todo_id, in_progress, ...). */
function collectSchemaTerms(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaTerms(item, into);
  } else if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      for (const key of Object.keys(record.properties)) into.add(key);
    }
    if (Array.isArray(record.enum)) {
      for (const value of record.enum) if (typeof value === "string") into.add(value);
    }
    for (const value of Object.values(record)) collectSchemaTerms(value, into);
  }
  return into;
}
const SCHEMA_TERMS = collectSchemaTerms(BRIDGE_TOOL_DEFINITIONS.map((tool) => tool.inputSchema), new Set<string>());

const PROSE: ReadonlyArray<readonly [string, string]> = [
  ["normal-mode instructions", buildServerInstructions(false)],
  ["read-only instructions", buildServerInstructions(true)],
  ["read-only ON transition notice", buildReadOnlyTransitionNotice(true)],
  ["read-only OFF transition notice", buildReadOnlyTransitionNotice(false)],
  ["read-only session notice", buildReadOnlySessionNotice()],
  ["Plan mode block error for a blocked tool", planModeBlockError([...READ_ONLY_BLOCKED_TOOL_NAMES][0], {}) ?? ""],
  ["Plan mode block error for a command", planModeBlockError("run_command", { command: "rm -rf dist" }) ?? ""],
  // Panel text that names tools (zh and en).
  ...(["modePlanTitle", "readOnlyEnabledNotice", "readOnlyDisabledNotice"] as const)
    .flatMap((key) => [[`panel ${key} (zh)`, String((zhMessages as any)[key])], [`panel ${key} (en)`, String((enMessages as any)[key])]] as Array<[string, string]>),
];

test("every snake_case identifier in model-facing prose is a live tool or schema term", () => {
  for (const [label, text] of PROSE) {
    for (const [token] of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      assert.ok(
        TOOL_NAMES.has(token) || SCHEMA_TERMS.has(token),
        `${label} mentions "${token}", which is neither a tool name nor a tool parameter/enum value. Was a tool renamed or removed?`,
      );
    }
  }
});

test("lowercase names that start a bullet (for example \"- lsp for ...\") are live tools", () => {
  let checked = 0;
  for (const [label, text] of PROSE) {
    for (const match of text.matchAll(/^- ([a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)*)\b/gm)) {
      for (const name of match[1].split("/")) {
        checked += 1;
        assert.ok(TOOL_NAMES.has(name), `${label} starts a bullet with "${name}", which is not a tool. Was a tool renamed or removed?`);
      }
    }
  }
  assert.ok(checked > 0, "the bullet pattern no longer matches the instructions; update this test");
});

test("read-only guidance only recommends tools that stay available", () => {
  const text = buildServerInstructions(true);
  const [, readOnlySection = "", ...rest] = text.split("\n\n");
  const guidance = readOnlySection.split("\n").slice(1).join("\n"); // lines after "Plan mode is ACTIVE: … are disabled …"
  for (const tool of TOOL_NAMES) {
    if (!READ_ONLY_BLOCKED_TOOL_NAMES.has(tool)) continue;
    assert.ok(!new RegExp(`\\b${tool}\\b`).test(guidance), `read-only guidance recommends blocked tool ${tool}`);
    assert.ok(!new RegExp(`\\b${tool}\\b`).test(rest.join("\n\n")), `read-only instructions body mentions blocked tool ${tool}`);
  }
});
