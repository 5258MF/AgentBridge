import test from "node:test";
import assert from "node:assert/strict";
import { getIdeToolDefinition, IDE_TOOL_DEFINITIONS } from "../src/extension/src/ide-tool-definitions.js";

test("every IDE tool has a name the host can dispatch on", () => {
  const names = IDE_TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, `duplicate tool name: ${names.join(", ")}`);
  for (const tool of IDE_TOOL_DEFINITIONS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, tool.name);
    assert.equal(tool.vscodeToolName, `agentbridge_${tool.name}`, tool.name);
    assert.ok(tool.capability === "read" || tool.capability === "execute", tool.name);
    assert.ok(tool.description.length > 0, tool.name);
  }
  assert.equal(getIdeToolDefinition("run_command")?.capability, "execute");
  assert.equal(getIdeToolDefinition("nope"), undefined);
});

test("every IDE tool refuses arguments it did not ask for", () => {
  // The caller is a model on the other side of the Bridge. A schema that accepted extra
  // fields would let a misspelled one be dropped without a word, and the tool would answer
  // a question that was never asked.
  for (const tool of IDE_TOOL_DEFINITIONS) {
    const schema = tool.inputSchema as Record<string, unknown>;
    assert.equal(schema.type, "object", tool.name);
    assert.equal(schema.additionalProperties, false, tool.name);
  }
});

test("every placeholder in a description is one the host fills in", () => {
  // Descriptions carry ${RUNTIME_SHELL_DESCRIPTION} and ${RUNTIME_SHELL_SYNTAX_HINT}, which
  // the host replaces with the shell it is actually running. A placeholder nobody knows
  // reaches the model verbatim, which reads as instructions to guess at.
  const known = new Set(["${RUNTIME_SHELL_DESCRIPTION}", "${RUNTIME_SHELL_SYNTAX_HINT}"]);
  let found = 0;
  for (const tool of IDE_TOOL_DEFINITIONS) {
    for (const placeholder of tool.description.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? []) {
      found += 1;
      assert.ok(known.has(placeholder), `${tool.name} ships an unfilled placeholder: ${placeholder}`);
    }
  }
  assert.equal(found, 2, "the shell placeholders are expected here; add a new one to this list with its substitution");
});

test("every number the tool brings into range says so, and the ones it refuses do not", () => {
  // The schema's minimum and maximum are not enforced by every client, so the tool list is the
  // only place a model can learn a limit: it cannot discover one by being turned down. Three of
  // these numbers were being clamped while saying nothing about it - max_bytes, and the two
  // max_results - which is the gap this closes. line and column are the other family: a position
  // is refused rather than moved, because a line silently clamped to 1 answers a question about
  // a different line, so those two must not carry the sentence.
  const marker = "A value outside the range is brought into it";
  let clamped = 0;
  for (const tool of IDE_TOOL_DEFINITIONS) {
    const properties = (tool.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
    for (const [name, schema] of Object.entries(properties)) {
      if (schema.type !== "integer") continue;
      const description = String(schema.description ?? "");
      if (Array.isArray(schema.enum) || "maximum" in schema || name === "offset") {
        clamped += 1;
        assert.ok(description.includes(marker), `${tool.name}.${name} is brought into range but says nothing about it`);
      } else if (tool.name === "lsp" && (name === "line" || name === "column")) {
        assert.ok(!description.includes(marker), `${tool.name}.${name} is refused, not clamped, so it must not promise a fallback`);
      }
    }
  }
  assert.ok(clamped >= 7, `expected the clamped numbers to be found, saw ${clamped}`);
});
