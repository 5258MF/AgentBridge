import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { vscodeTest, languages, workspace } from "./helpers/fake-vscode.js";
import { boundedDiagnosticMessage, getDiagnostics } from "../src/extension/src/ide-tool-broker.js";

const ROOT = process.cwd();

function reportOneDiagnosticAt(relative: string[]): void {
  (languages as { getDiagnostics: () => unknown }).getDiagnostics = () => [
    [
      { scheme: "file", fsPath: path.join(ROOT, ...relative) },
      [
        {
          severity: 0,
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
          message: "broken",
        },
      ],
    ],
  ];
}

function reportDiagnostics(entries: Array<{ relative: string[]; severity: number; count: number }>): void {
  (languages as { getDiagnostics: () => unknown }).getDiagnostics = () =>
    entries.map((entry) => [
      { scheme: "file", fsPath: path.join(ROOT, ...entry.relative) },
      Array.from({ length: entry.count }, (_, index) => ({
        severity: entry.severity,
        range: { start: { line: index, character: 0 }, end: { line: index, character: 5 } },
        message: `message ${index}`,
      })),
    ]);
}

function countReturned(scope: string): number {
  const text = getDiagnostics({ path: scope });
  const match = /^returned: (\d+)$/m.exec(text);
  assert.ok(match, `no count in the report: ${text}`);
  return Number(match[1]);
}

test("a scope finds the diagnostics under it", () => {
  vscodeTest.reset();
  (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ROOT } }];
  reportOneDiagnosticAt(["src", "models", "order.ts"]);
  assert.equal(countReturned("src/models"), 1);
  assert.equal(countReturned("src"), 1);
  assert.equal(countReturned("src/other"), 0);
});

test("on Windows a scope differing only in case still finds them", () => {
  // A Windows path names the same directory whatever case it is spelled in. The scope used to
  // be compared as a string against the path the language server reported, so a scope of
  // "SRC" - or a drive letter written the other way - answered "no diagnostics" for a
  // directory that has some. Asserted only where the two spellings are one path.
  if (process.platform !== "win32") return;
  vscodeTest.reset();
  (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ROOT } }];
  reportOneDiagnosticAt(["src", "models", "order.ts"]);
  assert.equal(countReturned("SRC/MODELS"), 1);
});

test("a severity value that cannot match anything is reported, not swallowed", () => {
  vscodeTest.reset();
  (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ROOT } }];
  reportOneDiagnosticAt(["src", "models", "order.ts"]);

  const partly = getDiagnostics({ path: "src", severity: ["error", "warn"] });
  assert.match(partly, /^ignored_severity_values: \["\\"warn\\""\]$/m);
  assert.match(partly, /^severity_filter_applied: true$/m);
  assert.match(partly, /^returned: 1$/m);

  // Nothing usable in the list: the filter is not applied at all, and the report says so rather
  // than answering "no diagnostics" for a directory that has some.
  const nothing = getDiagnostics({ path: "src", severity: ["bogus"] });
  assert.match(nothing, /^severity_filter_applied: false$/m);
  assert.match(nothing, /no severity filter was applied/);
  assert.match(nothing, /^returned: 1$/m);
});

test("an empty result says what the editor was looking at", () => {
  // "no diagnostics" is what a clean directory looks like and what an unexamined one looks like,
  // and the two are only distinguishable if the report says how many documents it covered.
  vscodeTest.reset();
  (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ROOT } }];
  (workspace as { textDocuments: unknown[] }).textDocuments = [];
  // The stubbed provider outlives vscodeTest.reset(), so the empty case has to clear it.
  (languages as { getDiagnostics: () => unknown }).getDiagnostics = () => [];

  const nothingTracked = getDiagnostics({ path: "src" });
  assert.match(nothingTracked, /^returned: 0$/m);
  assert.match(nothingTracked, /^documents_with_diagnostics: 0$/m);
  assert.match(nothingTracked, /^open_documents: 0$/m);
  assert.match(nothingTracked, /no document in this scope is open in the editor/);

  (workspace as { textDocuments: unknown[] }).textDocuments = [
    { uri: { scheme: "file", fsPath: path.join(ROOT, "src", "extension", "src", "glob.ts") } },
    { uri: { scheme: "file", fsPath: path.join(ROOT, "README.md") } },
  ];
  const openButClean = getDiagnostics({ path: "src" });
  assert.match(openButClean, /^open_documents: 1$/m, "only the document inside the scope counts");

  reportOneDiagnosticAt(["src", "models", "order.ts"]);
  const withOne = getDiagnostics({ path: "src" });
  assert.match(withOne, /^documents_with_diagnostics: 1$/m);
  assert.doesNotMatch(withOne, /no diagnostics were reported/, "a non-empty result needs no note");
});

test("the report names the limit it used, and says when it was not the one asked for", () => {
  // max_results is declared 1..500 in the schema and the SDK enforces neither end, so a caller
  // that asked for 900 was answered with 500 and had no way to see that it had been answered
  // with anything: a truncated report reads exactly like a directory with 500 problems in it.
  vscodeTest.reset();
  (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ROOT } }];
  reportOneDiagnosticAt(["src", "models", "order.ts"]);

  const plain = getDiagnostics({ path: "src" });
  assert.match(plain, /^max_results: 100$/m, "the default is named even when nothing was adjusted");
  assert.doesNotMatch(plain, /^adjusted:/m);

  const asked = getDiagnostics({ path: "src", max_results: 900 });
  assert.match(asked, /^max_results: 500$/m);
  assert.match(asked, /^adjusted: max_results was 900: above 500, so 500 was used\.$/m);
});

test("a report that had to be shortened keeps the errors, not the first files it saw", () => {
  // The walk used to stop as soon as it had max_results rows, and the sort by severity came
  // afterwards: with a noisy file reported first, ten hints filled the answer and the one
  // error in a later file was dropped - while total_matching still counted it and truncated
  // still said the report was short. A caller that asked for ten got ten hints and no way to
  // know an error existed.
  vscodeTest.reset();
  (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ROOT } }];
  reportDiagnostics([
    { relative: ["src", "aaa", "noisy.ts"], severity: 3, count: 100 },
    { relative: ["src", "zzz", "broken.ts"], severity: 0, count: 1 },
  ]);

  const text = getDiagnostics({ path: "src", max_results: 10 });
  assert.match(text, /^returned: 10$/m, text);
  assert.match(text, /^total_matching: 101$/m, text);
  assert.match(text, /^truncated: true$/m, text);
  assert.match(text, /severity: error/, "the error has to survive the shortening");
  assert.match(text, /zzz\/broken\.ts/, "and it has to come from the file it was reported in");
});

test("one diagnostic cannot spend the whole report by itself", () => {
  // A TypeScript error that expands a type can be longer than the report is allowed to be, and
  // it is emitted as a run of lines a caller reads positionally, so a message carrying its own
  // line breaks also reads as several entries.
  const long = "x".repeat(5_000);
  const bounded = boundedDiagnosticMessage(long);
  assert.ok(bounded.length < 2_100, `expected the message to be shortened, got ${bounded.length}`);
  assert.match(bounded, /\[truncated \d+ more characters\]$/);
  assert.match(boundedDiagnosticMessage("line one\nline two"), /^line one line two$/);
  assert.equal(boundedDiagnosticMessage("short"), "short");

  vscodeTest.reset();
  (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ROOT } }];
  reportDiagnostics([{ relative: ["src", "big.ts"], severity: 0, count: 1 }]);
  (languages as { getDiagnostics: () => unknown }).getDiagnostics = () => [
    [
      { scheme: "file", fsPath: path.join(ROOT, "src", "big.ts") },
      [{ severity: 0, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: long }],
    ],
  ];
  const text = getDiagnostics({ path: "src" });
  assert.ok(text.length < 6_000, `the report must not carry the whole message: ${text.length}`);
  assert.match(text, /truncated \d+ more characters/);
});

test("a diagnostic message is cut between characters, not through one", () => {
  // The cut counted UTF-16 units, so a message whose two-thousandth unit was the first half of
  // a surrogate pair ended in half a character: an unpaired surrogate, which is not text a
  // caller can print or compare, and which a JSON writer answers with a replacement character
  // or with an error. The count that follows the message was wrong in the same way - it counted
  // the halves of one character as two characters it had left out.
  const alone = (text: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) return true;
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    }
    return false;
  };
  const face = "\u{1f600}";
  const message = "x".repeat(1_999) + face + "tail";
  const bounded = boundedDiagnosticMessage(message, 2_000);
  assert.equal(alone(bounded), false, "the halves of one character stay together");
  assert.ok(bounded.includes(face), `the character at the cut survives whole: ${bounded.slice(-60)}`);
  assert.match(bounded, /\[truncated 4 more characters\]$/, "the four characters left out are counted as four");

  // A message written entirely in the first plane is unchanged, and so is one that fits.
  const plain = "x".repeat(2_004);
  assert.equal(boundedDiagnosticMessage(plain, 2_000), `${"x".repeat(2_000)} ...[truncated 4 more characters]`);
  assert.equal(boundedDiagnosticMessage("x".repeat(2_000), 2_000), "x".repeat(2_000));
});

test("the open-document count is spelled as a count, not as a placeholder", () => {
  // "1 document(s)" reads as a string a caller has to parse, and the note is the one thing
  // standing between an empty report and the belief that the files are clean.
  vscodeTest.reset();
  (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: ROOT } }];
  (languages as { getDiagnostics: () => unknown }).getDiagnostics = () => [];
  (workspace as { textDocuments: unknown[] }).textDocuments = [
    { uri: { scheme: "file", fsPath: path.join(ROOT, "README.md") } },
  ];
  assert.match(getDiagnostics({}), /1 document in this scope is open in the editor/);
  (workspace as { textDocuments: unknown[] }).textDocuments = [
    { uri: { scheme: "file", fsPath: path.join(ROOT, "README.md") } },
    { uri: { scheme: "file", fsPath: path.join(ROOT, "CHANGELOG.md") } },
  ];
  assert.match(getDiagnostics({}), /2 documents in this scope are open in the editor/);
});
