import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BRIDGE_TOOL_DEFINITIONS, MAX_TODOS, PLAN_MODE_COMMAND_TOOL_NAME, READ_ONLY_BLOCKED_TOOL_NAMES } from "../src/extension/src/server-instructions.js";
import {
  GET_COMMAND_OUTPUT_MAX_WAIT_MS,
  MAX_RETAINED_FINISHED_COMMANDS,
  RUN_COMMAND_MAX_FOREGROUND_WAIT_MS,
} from "../src/extension/src/ide-tool-definitions.js";
import { DEFAULT_READ_FILES_CONFIG } from "../src/extension/src/read-files.js";
import { renderToolCatalog } from "../src/extension/src/tool-catalog.js";

// run-tests.mjs runs node --test with cwd set to the extension root.
const root = process.cwd();
const catalogPath = path.join(root, "docs", "tool-catalog.md");
const CLOUDFLARE_ORIGIN_DEADLINE_MS = 100_000;

function tool(name: string): any {
  const found = BRIDGE_TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(found, `missing tool definition: ${name}`);
  return found;
}

test("docs/tool-catalog.md matches the live tool definitions", () => {
  const expected = renderToolCatalog(BRIDGE_TOOL_DEFINITIONS, { readOnlyBlocked: READ_ONLY_BLOCKED_TOOL_NAMES, planRestricted: new Set([PLAN_MODE_COMMAND_TOOL_NAME]) });
  if (process.env.AGENTBRIDGE_UPDATE_TOOL_CATALOG === "1") {
    fs.writeFileSync(catalogPath, expected, "utf8");
    return;
  }
  const actual = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8").replace(/\r\n/g, "\n") : "";
  assert.equal(actual, expected, "docs/tool-catalog.md is stale; run `npm run tool-catalog` and commit the result.");
});

test("every tool definition is well-formed", () => {
  const names = BRIDGE_TOOL_DEFINITIONS.map((definition) => definition.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const definition of BRIDGE_TOOL_DEFINITIONS) {
    const schema = definition.inputSchema as any;
    assert.match(definition.name, /^[a-z][a-z0-9_]*$/, `${definition.name}: tool names are snake_case`);
    assert.ok(definition.description.length >= 40, `${definition.name}: description is too short to guide a model`);
    assert.ok(definition.description.length <= 1600, `${definition.name}: description is ${definition.description.length} chars; keep it under 1600`);
    assert.equal(schema.type, "object", `${definition.name}: inputSchema must be an object`);
    assert.equal(schema.additionalProperties, false, `${definition.name}: reject unknown arguments`);
    for (const required of schema.required ?? []) {
      assert.ok(schema.properties && required in schema.properties, `${definition.name}: required ${required} is not a declared property`);
    }
  }
  for (const blocked of READ_ONLY_BLOCKED_TOOL_NAMES) assert.ok(names.includes(blocked), `read-only list names unknown tool ${blocked}`);
  assert.ok(names.includes(PLAN_MODE_COMMAND_TOOL_NAME), `Plan mode command tool ${PLAN_MODE_COMMAND_TOOL_NAME} is not a tool`);
});

test("every parameter has a description and descriptions start with a one-line summary", () => {
  function visit(toolName: string, schema: any, prefix: string): void {
    for (const [name, property] of Object.entries<any>(schema.properties ?? {})) {
      assert.ok(typeof property.description === "string" && property.description.length > 0, `${toolName}: parameter ${prefix}${name} has no description`);
      if (property.type === "array" && property.items?.type === "object") visit(toolName, property.items, `${prefix}${name}[].`);
    }
  }
  for (const definition of BRIDGE_TOOL_DEFINITIONS) {
    visit(definition.name, definition.inputSchema, "");
    const [summary, blank] = definition.description.split("\n");
    assert.ok(summary.length > 0 && summary.length <= 160, `${definition.name}: first line should be a short summary`);
    if (definition.description.includes("\n")) assert.equal(blank, "", `${definition.name}: blank line after the summary`);
  }
});

test("limits stated in descriptions and schemas match the enforced constants", () => {
  const maxFiles = DEFAULT_READ_FILES_CONFIG.maxFilesPerCall;
  const readFiles = tool("read_files");
  assert.equal(readFiles.inputSchema.properties.files.maxItems, maxFiles);
  assert.match(readFiles.description, new RegExp(`at most ${maxFiles} files per call`));

  const setTodos = tool("set_todos");
  assert.equal(setTodos.inputSchema.properties.todos.maxItems, MAX_TODOS);
  assert.match(setTodos.description, new RegExp(`at most ${MAX_TODOS} items`));

  const runCommand = tool("run_command");
  assert.equal(runCommand.inputSchema.properties.timeout_ms.maximum, RUN_COMMAND_MAX_FOREGROUND_WAIT_MS);
  assert.equal(runCommand.inputSchema.properties.timeout_ms.default, RUN_COMMAND_MAX_FOREGROUND_WAIT_MS);

  const getOutput = tool("get_command_output");
  assert.equal(getOutput.inputSchema.properties.wait_ms.maximum, GET_COMMAND_OUTPUT_MAX_WAIT_MS);
  assert.match(getOutput.description, new RegExp(`at most ${GET_COMMAND_OUTPUT_MAX_WAIT_MS}\\b`));
  assert.match(getOutput.description, new RegExp(`${MAX_RETAINED_FINISHED_COMMANDS} most recent finished commands`));

  assert.ok(RUN_COMMAND_MAX_FOREGROUND_WAIT_MS < CLOUDFLARE_ORIGIN_DEADLINE_MS, "foreground waits must return before Cloudflare's 100 s origin deadline");
  assert.ok(GET_COMMAND_OUTPUT_MAX_WAIT_MS < CLOUDFLARE_ORIGIN_DEADLINE_MS, "output waits must return before Cloudflare's 100 s origin deadline");
});

test("README tool counts and tool names match the definitions", () => {
  for (const [file, pattern] of [
    ["README.md", /\*\*(\d+) MCP tools\*\*/],
    ["README.zh-CN.md", /\*\*(\d+) 个 MCP 工具\*\*/],
  ] as const) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const match = text.match(pattern);
    assert.ok(match, `${file}: tool count line not found`);
    assert.equal(Number(match[1]), BRIDGE_TOOL_DEFINITIONS.length, `${file}: tool count is out of date`);
    for (const definition of BRIDGE_TOOL_DEFINITIONS) {
      assert.ok(text.includes(`\`${definition.name}\``), `${file}: does not mention \`${definition.name}\``);
    }
  }
});
