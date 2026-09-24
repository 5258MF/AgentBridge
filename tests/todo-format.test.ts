import assert from "node:assert/strict";
import test from "node:test";
import { formatSetTodosResult, type TodoLike } from "../src/extension/src/todo-format.js";

const MARKER = "Current todo list (authoritative; send the complete list to set_todos to change it):\n";

function parseList(text: string): unknown {
  const index = text.indexOf(MARKER);
  assert.ok(index >= 0, "result must contain the full-list marker");
  return JSON.parse(text.slice(index + MARKER.length));
}

test("set_todos result keeps the summary line and echoes the complete ordered list", () => {
  const todos: TodoLike[] = [
    { id: "a", title: "Read code", status: "completed" },
    { id: "b", title: "Patch handler", status: "in_progress" },
    { id: "c", title: "Run tests", status: "pending" },
  ];
  const text = formatSetTodosResult(todos);
  assert.ok(text.startsWith("Todo state updated in AgentBridge: 1/3 completed; current todo b: Patch handler."));
  assert.deepEqual(parseList(text), todos);
});

test("set_todos result without an in_progress item omits the current todo", () => {
  const text = formatSetTodosResult([{ id: "x", title: "Only", status: "pending" }]);
  assert.ok(text.startsWith("Todo state updated in AgentBridge: 0/1 completed."));
  assert.deepEqual(parseList(text), [{ id: "x", title: "Only", status: "pending" }]);
});

test("set_todos result echoes only id/title/status and escapes special characters as JSON", () => {
  const extra = { id: "q", title: "Say \"hi\"\nnext line", status: "pending", secret: "drop" } as unknown as TodoLike;
  const list = parseList(formatSetTodosResult([extra])) as Array<Record<string, unknown>>;
  assert.deepEqual(list, [{ id: "q", title: "Say \"hi\"\nnext line", status: "pending" }]);
});

test("clearing todos reports an explicit empty list", () => {
  assert.equal(formatSetTodosResult([]), "Todo state cleared in AgentBridge. Current todo list: []");
});
