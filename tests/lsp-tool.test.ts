import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeLspTool, setLspColdStartRetryDelaysForTests } from "../src/extension/src/lsp-tool.js";
import { Position, Range, Uri, vscodeTest, workspace } from "./helpers/fake-vscode.js";

const SOURCE = "export function alpha(): number {\n  return 1;\n}\n\nexport const beta = alpha();\n";

/** A one-file workspace (`src/a.ts`) with fast retries and a recording `executeCommand`. */
function fixture(answers: unknown[][], delays: readonly number[] = [0, 0, 0]) {
  vscodeTest.reset();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-lsp-")));
  const file = path.join(ws, "src", "a.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SOURCE);
  const originalFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
  const restoreDelays = setLspColdStartRetryDelaysForTests(delays);
  const calls: string[] = [];
  vscodeTest.setExecuteCommandHandler((id) => {
    calls.push(id);
    return answers.length > 1 ? answers.shift() : answers[0];
  });
  return {
    ws,
    file,
    calls,
    restore(): void {
      restoreDelays();
      workspace.workspaceFolders = originalFolders;
      vscodeTest.reset();
      fs.rmSync(ws, { recursive: true, force: true });
    },
  };
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number): Range {
  return new Range(new Position(startLine, startCharacter), new Position(endLine, endCharacter));
}

function documentSymbol(name: string, line: number) {
  return { name, kind: 11, detail: "", range: range(line, 0, line, 20), selectionRange: range(line, 16, line, 21) };
}

function location(file: string, line: number) {
  return { uri: { scheme: "file", fsPath: file, toString: () => file }, range: range(line, 16, line, 21) };
}

function field(output: string, name: string): string | undefined {
  return output.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
}

test("document_symbols retries an empty answer for a document it had to open, and reports the warm-up", async () => {
  const env = fixture([[], [], [documentSymbol("alpha", 0)]]);
  try {
    const output = await invokeLspTool({ operation: "document_symbols", path: "src/a.ts" });
    assert.deepEqual(env.calls, Array(3).fill("vscode.executeDocumentSymbolProvider"));
    assert.equal(field(output, "document_already_open"), "false");
    assert.equal(field(output, "initial_results"), "0");
    assert.equal(field(output, "retry_attempts"), "2");
    assert.equal(field(output, "provider_state_before_retry"), "warming");
    assert.equal(field(output, "provider_state"), "ready");
    assert.equal(field(output, "warmup_performed"), "true");
    assert.equal(field(output, "semantic_result_inconclusive"), "false");
    assert.equal(field(output, "total_results"), "1");
    assert.match(output, /name: "alpha"/);
    assert.equal(field(output, "note"), undefined);
  } finally {
    env.restore();
  }
});

test("document_symbols stays inconclusive when every retry is empty", async () => {
  const env = fixture([[]]);
  try {
    const output = await invokeLspTool({ operation: "document_symbols", path: "src/a.ts" });
    assert.equal(env.calls.length, 4, "one query plus one per backoff step");
    assert.equal(field(output, "retry_attempts"), "3");
    assert.equal(field(output, "provider_state_before_retry"), "warming");
    assert.equal(field(output, "provider_state"), "unknown");
    assert.equal(field(output, "provider_state_basis"), "public_api_ambiguous_empty_result");
    assert.equal(field(output, "warmup_performed"), "true");
    assert.equal(field(output, "semantic_result_inconclusive"), "true");
    assert.match(field(output, "note") ?? "", /does not prove absence/);
  } finally {
    env.restore();
  }
});

test("an empty answer for a document that was already open is returned without retrying", async () => {
  const env = fixture([[]], [10_000]);
  try {
    await workspace.openTextDocument(Uri.file(env.file));
    const started = Date.now();
    const output = await invokeLspTool({ operation: "document_symbols", path: "src/a.ts" });
    assert.ok(Date.now() - started < 1_000, "no backoff delay");
    assert.equal(env.calls.length, 1);
    assert.equal(field(output, "document_already_open"), "true");
    assert.equal(field(output, "retry_attempts"), "0");
    assert.equal(field(output, "provider_state_before_retry"), "null");
    assert.equal(field(output, "provider_state"), "unknown");
    assert.equal(field(output, "warmup_performed"), "false");
    assert.match(field(output, "note") ?? "", /does not prove absence/);
  } finally {
    env.restore();
  }
});

test("a non-empty first answer is used as is, without delay", async () => {
  const env = fixture([], [10_000]);
  try {
    const target = location(env.file, 0);
    vscodeTest.setExecuteCommandHandler((id) => {
      env.calls.push(id);
      return [target];
    });
    const started = Date.now();
    const output = await invokeLspTool({ operation: "definition", path: "src/a.ts", line: 5, column: 21 });
    assert.ok(Date.now() - started < 1_000, "no backoff delay");
    assert.deepEqual(env.calls, ["vscode.executeDefinitionProvider"]);
    assert.equal(field(output, "initial_results"), "1");
    assert.equal(field(output, "retry_attempts"), "0");
    assert.equal(field(output, "provider_state_before_retry"), "null");
    assert.equal(field(output, "provider_state"), "ready");
    assert.equal(field(output, "warmup_performed"), "false");
    assert.equal(field(output, "path"), JSON.stringify("src/a.ts"));
    assert.equal(field(output, "range"), "1:17-1:22");
  } finally {
    env.restore();
  }
});

test("hover and references retry on a cold document too", async () => {
  const env = fixture([[], [{ contents: ["function alpha(): number"], range: range(0, 16, 0, 21) }]]);
  try {
    const output = await invokeLspTool({ operation: "hover", path: "src/a.ts", line: 1, column: 18 });
    assert.deepEqual(env.calls, ["vscode.executeHoverProvider", "vscode.executeHoverProvider"]);
    assert.equal(field(output, "retry_attempts"), "1");
    assert.equal(field(output, "provider_state"), "ready");
    assert.equal(field(output, "warmup_performed"), "true");
    assert.match(output, /function alpha\(\): number/);
  } finally {
    env.restore();
  }

  const refs = fixture([]);
  try {
    const declaration = location(refs.file, 0);
    const use = { ...location(refs.file, 4), range: range(4, 20, 4, 25) };
    let referenceCalls = 0;
    vscodeTest.setExecuteCommandHandler((id) => {
      refs.calls.push(id);
      if (id === "vscode.executeReferenceProvider") return ++referenceCalls === 1 ? [] : [declaration, use];
      return [{ targetUri: declaration.uri, targetRange: range(0, 0, 2, 1), targetSelectionRange: declaration.range }];
    });
    const output = await invokeLspTool({ operation: "references", path: "src/a.ts", line: 1, column: 18, include_declaration: false });
    assert.deepEqual(refs.calls, ["vscode.executeReferenceProvider", "vscode.executeReferenceProvider", "vscode.executeDefinitionProvider"]);
    assert.equal(field(output, "retry_attempts"), "1");
    assert.equal(field(output, "provider_state"), "ready");
    assert.equal(field(output, "total_results"), "1", "the declaration is filtered out after the retry");
    assert.equal(field(output, "range"), "5:21-5:26");
  } finally {
    refs.restore();
  }
});

test("cancelling the tool call stops the backoff", async () => {
  const env = fixture([[]], [10_000, 10_000, 10_000]);
  let cancelled = false;
  const listeners = new Set<() => void>();
  const token = {
    get isCancellationRequested(): boolean {
      return cancelled;
    },
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  try {
    setTimeout(() => {
      cancelled = true;
      for (const listener of [...listeners]) listener();
    }, 20);
    const started = Date.now();
    const output = await invokeLspTool({ operation: "document_symbols", path: "src/a.ts" }, token as never);
    assert.ok(Date.now() - started < 2_000, "returned without waiting out the backoff");
    assert.equal(env.calls.length, 1);
    assert.equal(field(output, "retry_attempts"), "0");
    assert.equal(field(output, "provider_state"), "unknown");
    assert.equal(listeners.size, 0, "the cancellation listener is disposed");
  } finally {
    env.restore();
  }
});
