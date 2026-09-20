import test from "node:test";
import assert from "node:assert/strict";
import { documentSymbolBlocks } from "../src/extension/src/lsp-tool.js";

const span = (line: number): any => ({ start: { line, character: 0 }, end: { line, character: 4 } });

/** 5 is Class and 6 is Method in vscode.SymbolKind; only the numbers reach the formatter. */
function symbol(name: string, kind: number, children: any[] = [], line = 0): any {
  return { name, kind, detail: "", range: span(line), selectionRange: span(line), children };
}

test("a symbol nested in a class is reported, not just the class", () => {
  // A DocumentSymbol carries its children, and that is where a class keeps its methods and
  // fields. Walking only the top level reported the class and nothing inside it, which for
  // TypeScript or Python is most of the file.
  const blocks = documentSymbolBlocks(
    [symbol("OrderService", 5, [symbol("place", 6, [], 4), symbol("cancel", 6, [], 8)])],
    { relative: "src/order.ts", root: "ws" },
  );
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /name: "OrderService"/);
  assert.match(blocks[1], /name: "place"/);
  assert.match(blocks[2], /name: "cancel"/);
});

test("a nested symbol says what encloses it, however deep", () => {
  const blocks = documentSymbolBlocks(
    [symbol("App", 5, [symbol("Router", 5, [symbol("match", 6, [], 2)])])],
    { relative: "src/app.ts", root: "ws" },
  );
  assert.match(blocks[1], /container: "App"/);
  assert.match(blocks[2], /container: "App.Router"/);
});

test("a flat SymbolInformation result keeps its own container and location", () => {
  // Providers that return the older shape carry no children and a location instead of a range.
  const flat = {
    name: "helper",
    kind: 12,
    containerName: "utils",
    location: { uri: { toString: () => "file:///ws/src/util.ts", scheme: "file", fsPath: "/ws/src/util.ts" }, range: span(1) },
  };
  const blocks = documentSymbolBlocks([flat as any], { relative: "src/util.ts", root: "ws" });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /name: "helper"/);
  assert.match(blocks[0], /container: "utils"/);
});
