import test from "node:test";
import assert from "node:assert/strict";
import { BridgePanelProvider } from "../src/extension/src/bridge-panel.js";
import { vscodeTest } from "./helpers/fake-vscode.js";
import { createFakeWebviewView, executePanelHtml } from "./helpers/panel-harness.js";

function renderPanel(): ReturnType<typeof executePanelHtml> {
  vscodeTest.reset();
  const provider = new BridgePanelProvider({
    getStatus: () => ({ state: "running", tunnelProvider: "cloudflare" }),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  return executePanelHtml(view.webview.html);
}

function find(node: any, predicate: (candidate: any) => boolean): any {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function editActivity(): any {
  return {
    id: "activity-1",
    tool: "apply_patch",
    status: "completed",
    presentation: {
      kind: "edit",
      title: "Edit a.txt",
      items: [{ kind: "file", path: "a.txt" }],
      diffPreview: [
        {
          path: "a.txt",
          hunks: [
            {
              oldStart: 1,
              newStart: 1,
              lines: [
                { kind: "context", oldLine: 1, newLine: 1, text: "first" },
                { kind: "delete", oldLine: 2, text: "second" },
                { kind: "add", newLine: 2, text: "SECOND" },
              ],
            },
          ],
        },
      ],
    },
  };
}

test("a directory entry is opened as a folder", () => {
  // The host marks a directory with kind "folder" and looks for a boolean of the same name;
  // the panel read a "folder" field the items never had, so every directory was handed to
  // showTextDocument, which cannot open one.
  const harness = renderPanel();
  harness.dispatchMessage({
    type: "status",
    status: {
      state: "running",
      revision: 1,
      activities: [
        {
          id: "activity-2",
          tool: "list_directory",
          status: "completed",
          presentation: {
            kind: "files",
            title: "Listed src",
            items: [{ kind: "folder", path: "src" }, { kind: "file", path: "a.txt" }],
          },
        },
      ],
    },
  });
  harness.posted.length = 0;

  const rows = find(harness.element("timeline"), (node) => node.className === "agentbridge-tool-item");
  assert.ok(rows, "the activity items must be rendered");
  rows.dispatch("click");

  const message = harness.posted.at(-1);
  assert.equal(message.type, "openResource");
  assert.equal(message.value.path, "src");
  assert.equal(message.value.folder, true);
});

test("the mini diff renders the hunks the host sends", () => {
  const harness = renderPanel();
  harness.dispatchMessage({ type: "status", status: { state: "running", revision: 1, activities: [editActivity()] } });

  const added = find(harness.element("timeline"), (node) => node.className === "agentbridge-mini-diff-line add");
  assert.ok(added, "the added line must be rendered");
  const deleted = find(harness.element("timeline"), (node) => node.className === "agentbridge-mini-diff-line delete");
  assert.ok(deleted, "the removed line must be rendered");

  const texts = [added, deleted].map((row) => row.children.map((child: any) => child.textContent).join(""));
  assert.ok(texts.some((text) => text.includes("SECOND")), texts.join(" | "));
  assert.ok(texts.some((text) => text.includes("second")), texts.join(" | "));
});

test("the in-progress todo shows the progress reported against it", () => {
  // The row read todo.phase, todo.message and todo.percent, and none of them exist: the host
  // keeps a todo as an id, a title and a status, and report_progress files the phase as an
  // activity carrying the todo's id. Every row therefore drew an empty progress span.
  const harness = renderPanel();
  harness.dispatchMessage({
    type: "status",
    status: {
      state: "running",
      revision: 1,
      todos: [
        { id: "t1", title: "Read it", status: "completed" },
        { id: "t2", title: "Patch it", status: "in_progress" },
        { id: "t3", title: "Verify it", status: "pending" },
      ],
      activities: [
        { id: 1, tool: "report_progress", status: "progress", todoId: "t2", todoTitle: "Patch it", phase: "Applying", message: "rewriting line 4", percent: 60 },
        { id: 2, tool: "report_progress", status: "progress", todoId: "t2", todoTitle: "Patch it", phase: "Verifying", message: "running the build", percent: 90 },
      ],
    },
  });

  const row = find(harness.element("todosRegion"), (node) => node.className === "agentbridge-todo in-progress");
  assert.ok(row, "the in-progress todo must be rendered");
  const progress = find(row, (node) => node.className === "agentbridge-todo-progress");
  assert.ok(progress, "the in-progress todo must show what the agent is doing");
  const texts = progress.children.map((child: any) => child.textContent).join(" | ");
  assert.equal(texts, "Verifying | running the build | 90%", texts);
});

test("a todo the agent has not reported on gets no progress of its own", () => {
  const harness = renderPanel();
  harness.dispatchMessage({
    type: "status",
    status: {
      state: "running",
      revision: 1,
      todos: [{ id: "t1", title: "Patch it", status: "in_progress" }],
      activities: [],
    },
  });

  const row = find(harness.element("todosRegion"), (node) => node.className === "agentbridge-todo in-progress");
  assert.ok(row, "the in-progress todo must be rendered");
  assert.equal(find(row, (node) => node.className === "agentbridge-todo-progress"), undefined);
});

test("the row being worked on carries the class the stylesheet highlights", () => {
  // The class came from the raw status, "in_progress", while every rule for the current row
  // is written ".agentbridge-todo.in-progress", so the highlight, the spinner colour and the
  // percent colour never reached the one row they were written for.
  vscodeTest.reset();
  const provider = new BridgePanelProvider({
    getStatus: () => ({ state: "running", tunnelProvider: "cloudflare" }),
  } as any, Promise.resolve());
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view);
  const harness = executePanelHtml(view.webview.html);
  harness.dispatchMessage({
    type: "status",
    status: {
      state: "running",
      revision: 1,
      todos: [{ id: "t1", title: "Patch it", status: "in_progress" }],
      activities: [],
    },
  });

  const styled = [...view.webview.html.matchAll(/\.agentbridge-todo\.([a-z-]+)/g)].map((match) => match[1]);
  assert.ok(styled.includes("in-progress"), "the stylesheet must still have a rule for the current row");
  const row = find(harness.element("todosRegion"), (node) => node.className.startsWith("agentbridge-todo "));
  assert.ok(row, "the todo row must be rendered");
  // The harness keeps classList separate from className, so read the classes off className.
  assert.ok(row.className.split(" ").includes("in-progress"), "the row must carry the class the stylesheet styles: " + row.className);
});

test("opening the full diff sends the diff, not an empty payload", () => {
  // The panel read file.diff while the host sends only hunks, so the button posted nothing
  // and the host rejected it with "Bridge diff content is required".
  const harness = renderPanel();
  harness.dispatchMessage({ type: "status", status: { state: "running", revision: 1, activities: [editActivity()] } });
  harness.posted.length = 0;

  const button = find(harness.element("timeline"), (node) => node.textContent === "⇄");
  assert.ok(button, "the open-diff button must be rendered");
  button.dispatch("click");

  const message = harness.posted.at(-1);
  assert.equal(message.type, "openDiff");
  assert.equal(message.value.path, "a.txt");
  assert.ok(typeof message.value.diff === "string" && message.value.diff.length > 0, "a diff must be sent");
  assert.ok(message.value.diff.includes("--- a.txt"), message.value.diff);
  assert.ok(message.value.diff.includes("@@ -1 +1 @@"), message.value.diff);
  assert.ok(message.value.diff.includes("-second"), message.value.diff);
  assert.ok(message.value.diff.includes("+SECOND"), message.value.diff);
});
