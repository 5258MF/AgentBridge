import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { applyPatch, dominantEol, createPathResolutionCache, findSequence, resolveNewPath, patchPathKey } from "../src/extension/src/apply-patch.js";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-apply-patch-"));
}

async function call(root: string, patch: string, expectedVersions?: Record<string, string>) {
  try {
    const result = await applyPatch({ patch, expected_versions: expectedVersions }, { workspaceRoots: [root] });
    return { ok: true as const, result };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

const sha256 = (root: string, relative: string): string =>
  `sha256:${createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex")}`;

function seed(root: string, text = "line1\n\nline3\n"): void {
  fs.writeFileSync(path.join(root, "a.txt"), text, "utf8");
}

const read = (root: string): string => fs.readFileSync(path.join(root, "a.txt"), "utf8").replace(/\r\n/g, "\n");

// Same as read() but keeps the bytes as they are: a trailing newline is the thing under test.
const readRaw = (root: string): string => fs.readFileSync(path.join(root, "a.txt"), "utf8");

test("an empty context line written without its leading space is accepted", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", " line1", "", "-line3", "+line3b", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(read(root), "line1\n\nline3b\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a trailing blank line is a separator, not file content", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", " line1", "", "-line3", "+line3b", "", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(read(root), "line1\n\nline3b\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a blank line between two hunks separates them", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-line1", "+line1b", "", "@@", "-line3", "+line3c", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(read(root), "line1b\n\nline3c\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a path written with a leading dot-slash names the same file", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(
      root,
      [
        "*** Begin Patch",
        "*** Update File: ./a.txt",
        "@@",
        "-line1",
        "+one",
        "",
        "*** Update File: a.txt",
        "@@",
        "-line3",
        "+three",
        "*** End Patch",
      ].join("\n"),
    );
    assert.equal(out.ok, false);
    assert.ok((out.ok ? "" : out.error).includes("more than once"), out.ok ? "" : out.error);
    assert.equal(read(root), "line1\n\nline3\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an expected version keyed with a leading dot-slash still matches", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(
      root,
      ["*** Begin Patch", "*** Update File: a.txt", "@@", "-line1", "+line1b", "*** End Patch"].join("\n"),
      { "./a.txt": sha256(root, "a.txt") },
    );
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(read(root), "line1b\n\nline3\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unsupported hunk marker is still rejected", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", " line1", "?not-a-marker", "*** End Patch"].join("\n"));
    assert.equal(out.ok, false);
    assert.ok((out.ok ? "" : out.error).includes("INVALID_PATCH"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a repeated hunk is rejected instead of applying the change twice", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", " line1", "+inserted", "@@", " line1", "+inserted", "*** End Patch"].join("\n"));
    assert.equal(out.ok, false);
    assert.ok((out.ok ? "" : out.error).includes("INVALID_PATCH"));
    assert.equal(read(root), "line1\n\nline3\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("editing without an expected version fails instead of overwriting unseen content", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-line1", "+line1b", "*** End Patch"].join("\n"));
    assert.equal(out.ok, false);
    assert.ok((out.ok ? "" : out.error).includes("MISSING_EXPECTED_VERSION"));
    assert.equal(read(root), "line1\n\nline3\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deleting without an expected version fails and keeps the file", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(root, ["*** Begin Patch", "*** Delete File: a.txt", "*** End Patch"].join("\n"));
    assert.equal(out.ok, false);
    assert.ok((out.ok ? "" : out.error).includes("MISSING_EXPECTED_VERSION"));
    assert.equal(fs.existsSync(path.join(root, "a.txt")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stale version still reports STALE_FILE", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-line1", "+line1b", "*** End Patch"].join("\n"), { "a.txt": `sha256:${"0".repeat(64)}` });
    assert.equal(out.ok, false);
    assert.ok((out.ok ? "" : out.error).includes("STALE_FILE"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("adding a file needs no expected version", async () => {
  const root = workspace();
  try {
    const out = await call(root, ["*** Begin Patch", "*** Add File: new.txt", "+hello", "*** End Patch"].join("\n"));
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "hello\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a blank line inside an Add File block separates it from the next", async () => {
  // Everywhere else in a patch a blank line is a separator, so one between two Add File
  // sections was read as content that had lost its '+' and the whole patch was rejected.
  const root = workspace();
  try {
    const out = await call(root, [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+hello",
      "",
      "*** Add File: b.txt",
      "+world",
      "*** End Patch",
    ].join("\n"));
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hello\n");
    assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "world\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty line in a new file is still written as a bare plus", async () => {
  const root = workspace();
  try {
    const out = await call(root, ["*** Begin Patch", "*** Add File: a.txt", "+hello", "+", "+world", "*** End Patch"].join("\n"));
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hello\n\nworld\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file that ends without a newline is marked, and the marker is accepted back", async () => {
  const root = workspace();
  try {
    seed(root, "line1\nline2");
    const patch = ["*** Begin Patch", "*** Update File: a.txt", "@@", " line1", "-line2", "+line2b", "*** End Patch"].join("\n");
    const marked = await call(root, patch, { "a.txt": sha256(root, "a.txt") });
    assert.equal(marked.ok, true, marked.ok ? "" : marked.error);
    assert.ok((marked.ok ? marked.result.diff : "").includes("\\ No newline at end of file"));

    // Marker after the removal only: the old side lacked the newline, the new side has one.
    seed(root, "line1\nline2");
    const withMarker = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", " line1", "-line2", "\\ No newline at end of file", "+line2b", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(withMarker.ok, true, withMarker.ok ? "" : withMarker.error);
    assert.equal(read(root), "line1\nline2b\n");

    // Markers on both sides: the new file keeps having no trailing newline.
    seed(root, "line1\nline2");
    const bothMarkers = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", " line1", "-line2", "\\ No newline at end of file", "+line2b", "\\ No newline at end of file", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(bothMarkers.ok, true, bothMarkers.ok ? "" : bothMarkers.error);
    assert.equal(read(root), "line1\nline2b");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a marker after a blank line describes both sides, not the one the line before named", async () => {
  // An empty line inside a hunk is an empty context line, but it did not move the marker that
  // says which side the last line belonged to. Following an addition, that left the marker
  // reading as "the new file ends without a newline" only: the old side was never marked, so
  // the check that the file really ends that way was skipped and the patch was applied to a
  // file it contradicts - here one that ends with a newline.
  const root = workspace();
  try {
    seed(root, "x\n\n");
    const out = await call(
      root,
      ["*** Begin Patch", "*** Update File: a.txt", "@@", " x", "+bar", "", "\\ No newline at end of file", "*** End Patch"].join("\n"),
      { "a.txt": sha256(root, "a.txt") },
    );
    assert.equal(out.ok, false, "the marker claims the old file ends without a newline, and it does not");
    assert.match(out.ok ? "" : out.error, /ends with one/, out.ok ? "" : out.error);
    assert.equal(readRaw(root), "x\n\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a marker in the middle of a hunk is rejected instead of stripping the newline", async () => {
  // "No newline at end of file" describes a file's last line. Here it sits after a context
  // line with two more lines behind it, so it describes nothing at all - and used to be
  // believed, quietly turning "b\nA\nc\n" into "b\nA\nc" and reporting success.
  const root = workspace();
  try {
    seed(root, "a\nb\nc\n");
    const out = await call(
      root,
      ["*** Begin Patch", "*** Update File: a.txt", "@@", "-a", " b", "\\ No newline at end of file", "+A", " c", "*** End Patch"].join("\n"),
      { "a.txt": sha256(root, "a.txt") },
    );
    assert.equal(out.ok, false);
    assert.ok((out.ok ? "" : out.error).includes("must follow the last line of the hunk"), out.ok ? "" : out.error);
    assert.equal(read(root), "a\nb\nc\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a marker the file contradicts is rejected instead of being dropped", async () => {
  // The marker follows a removal, so it speaks for the old side: it claims the file ends
  // without a newline. This file ends with one, so the patch was written against different
  // content and must not be applied - dropping the claim silently kept the newline.
  const root = workspace();
  try {
    seed(root, "a\nb\n");
    const out = await call(
      root,
      ["*** Begin Patch", "*** Update File: a.txt", "@@", "-a", "-b", "\\ No newline at end of file", "+a", "*** End Patch"].join("\n"),
      { "a.txt": sha256(root, "a.txt") },
    );
    assert.equal(out.ok, false);
    assert.ok((out.ok ? "" : out.error).includes("PATCH_CONTEXT_MISMATCH"), out.ok ? "" : out.error);
    assert.equal(read(root), "a\nb\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removing the trailing newline the way git writes it works", async () => {
  // The marker belongs to the last line of the new side, which is what git emits for this
  // change: "a\nb\n" -> "a".
  const root = workspace();
  try {
    seed(root, "a\nb\n");
    const out = await call(
      root,
      ["*** Begin Patch", "*** Update File: a.txt", "@@", "-a", "-b", "+a", "\\ No newline at end of file", "*** End Patch"].join("\n"),
      { "a.txt": sha256(root, "a.txt") },
    );
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(readRaw(root), "a");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a patch can add a final newline to a file that had none", async () => {
  const root = workspace();
  try {
    seed(root, "line1\nline2");
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", " line1", "-line2", "\\ No newline at end of file", "+line2", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(read(root), "line1\nline2\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file can be emptied and then written again", async () => {
  const root = workspace();
  try {
    seed(root, "line1\nline2\n");
    const emptied = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-line1", "-line2", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(emptied.ok, true, emptied.ok ? "" : emptied.error);
    assert.equal(fs.statSync(path.join(root, "a.txt")).size, 0, "emptying must leave zero bytes, not a lone newline");

    const filled = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "+fresh", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(filled.ok, true, filled.ok ? "" : filled.error);
    assert.equal(read(root), "fresh\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one stray CRLF does not turn a whole file into CRLF", () => {
  // The old rule was "any CRLF means CRLF", so patching one line of a mostly-LF file rewrote
  // every line ending and buried the real change in noise.
  assert.equal(dominantEol("a\nb\n\nc\r\n"), "\n");
  assert.equal(dominantEol("a\r\nb\r\nc\n"), "\r\n");
  assert.equal(dominantEol("a\nb\n"), "\n");
  assert.equal(dominantEol("no newlines"), "\n");
});

test("an insertion without context is rejected on a non-empty file", async () => {
  const root = workspace();
  try {
    seed(root, "line1\n");
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "+x", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, false);
    assert.ok((out.ok ? "" : out.error).includes("PATCH_CONTEXT_AMBIGUOUS"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an edit away from the end does not add a trailing newline", async () => {
  // Every hunk carries "ends with a newline" unless a marker denies it, so reading that off a
  // hunk in the middle of the file used to append a newline the patch never asked for.
  const root = workspace();
  try {
    seed(root, "line1\nline2\nline3");
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-line1", "+line1b", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(read(root), "line1b\nline2\nline3");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a path that does not exist yet is resolved once per call", async () => {
  // The parent directory is resolved through realpath, so it can be swapped between the
  // lock pass and the preflight pass exactly as an existing file's own path could. Sharing
  // the resolution is what keeps the lock and the write pointed at the same directory.
  //
  // The sharing is asserted through what it is for - the second resolution keeps pointing at
  // the directory the first one found, even after the link in between has been repointed -
  // rather than through the two calls returning the same object. A cache that stored copies
  // would satisfy the second one and fail the first.
  const root = workspace();
  try {
    // Two directories behind one name. Which one is reached is read off the resolved path
    // rather than compared against a written-out expectation: resolving a link keeps the
    // spelling the link was created with, so the same directory can come back as either an
    // 8.3 name or a long one.
    const firstTarget = path.join(root, "target-one");
    const secondTarget = path.join(root, "target-two");
    fs.mkdirSync(firstTarget);
    fs.mkdirSync(secondTarget);
    const link = path.join(root, "link");
    const parentOf = (filePath: string): string => path.basename(path.dirname(filePath));

    fs.symlinkSync(firstTarget, link, "junction");
    const cache = createPathResolutionCache();
    const first = await resolveNewPath("link/new.txt", [root], cache);
    assert.equal(parentOf(first.absolutePath), "target-one");

    fs.unlinkSync(link);
    fs.symlinkSync(secondTarget, link, "junction");

    const second = await resolveNewPath("link/new.txt", [root], cache);
    assert.equal(second.absolutePath, first.absolutePath, "the shared resolution must survive the swap");

    const fresh = await resolveNewPath("link/new.txt", [root]);
    assert.equal(parentOf(fresh.absolutePath), "target-two", "a call without the cache must follow the new link");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an edit away from the end keeps an existing trailing newline", async () => {
  const root = workspace();
  try {
    seed(root, "line1\nline2\nline3\n");
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-line1", "+line1b", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(read(root), "line1b\nline2\nline3\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const MARKER = "\\ No newline at end of file";

test("a marker after a removal describes only the old side", async () => {
  const root = workspace();
  try {
    seed(root, "a");
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-a", MARKER, "+B", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(readRaw(root), "B\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a marker at the end of the hunk describes the new side", async () => {
  const root = workspace();
  try {
    seed(root, "a\n");
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-a", "+B", MARKER, "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(readRaw(root), "B");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("markers on both sides describe both", async () => {
  const root = workspace();
  try {
    seed(root, "a");
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-a", MARKER, "+B", MARKER, "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(readRaw(root), "B");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a marker in the middle of a hunk is rejected", async () => {
  // Only a file's last line can lack a trailing newline, so a marker that lands anywhere
  // else is not a statement about the file. It used to be taken as one and silently
  // stripped the newline from a line in the middle.
  const root = workspace();
  try {
    seed(root, "a\nc\n");
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "-a", MARKER, "+B", " c", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.error, /INVALID_PATCH/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty file can be written with an additions-only hunk", async () => {
  // A file with no lines has exactly one position, so a hunk with no context and no
  // removals is unambiguous there - the opposite of the same hunk against a file that
  // has content, which matches everywhere and is rejected.
  const root = workspace();
  try {
    seed(root, "");
    const out = await call(root, ["*** Begin Patch", "*** Update File: a.txt", "@@", "+hello", "*** End Patch"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.equal(readRaw(root), "hello\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Add onto an existing empty file says how to write it instead", async () => {
  const root = workspace();
  try {
    seed(root, "");
    const out = await call(root, ["*** Begin Patch", "*** Add File: a.txt", "+hello", "*** End Patch"].join("\n"));
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.error, /FILE_ALREADY_EXISTS/);
    assert.match(out.ok ? "" : out.error, /Update File/, "an empty file has a way out and the error should name it");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Add onto an existing file with content gives the plain error", async () => {
  const root = workspace();
  try {
    seed(root, "already here\n");
    const out = await call(root, ["*** Begin Patch", "*** Add File: a.txt", "+hello", "*** End Patch"].join("\n"));
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.error, /FILE_ALREADY_EXISTS/);
    assert.doesNotMatch(out.ok ? "" : out.error, /Update File/, "the hint is only true of an empty file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a path is folded to one case only where the filesystem does", () => {
  assert.equal(patchPathKey("src/A.txt", "win32"), "src/a.txt");
  assert.equal(patchPathKey("src/A.txt", "darwin"), "src/a.txt");
  assert.equal(patchPathKey("src/A.txt", "linux"), "src/A.txt");
  assert.equal(patchPathKey("src/a.txt", "linux"), "src/a.txt");
});

test("a patch wrapped in a code fence is read as the patch it is", async () => {
  // A caller writing a patch wraps it in a fence about as often as not, and the fence says
  // nothing about the patch: refusing it costs a round trip and teaches nothing about the patch.
  for (const marker of ["```", "~~~"]) {
    const root = workspace();
    try {
      seed(root);
      const out = await call(root, [
        `${marker}patch`,
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        "-line1",
        "+line1b",
        "*** End Patch",
        marker,
      ].join("\n"), { "a.txt": sha256(root, "a.txt") });
      assert.equal(out.ok, true, `${marker}: ${out.ok ? "" : out.error}`);
      assert.match(read(root), /line1b/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a blank line before the opening directive is tolerated", async () => {
  const root = workspace();
  try {
    seed(root);
    const out = await call(root, [
      "",
      "",
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-line1",
      "+line1b",
      "*** End Patch",
    ].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, true, out.ok ? "" : out.error);
    assert.match(read(root), /line1b/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("both halves of a fence are treated the same way", async () => {
  // A fence that was opened and never closed was forgiven, while one that was closed and never
  // opened was refused as content after the closing directive - the same wrapper, the same
  // mistake, and two answers depending on which half the caller dropped. Both ends are stripped
  // alike now. Neither halves what a patch has to be: content that is not a fence is still
  // content, wherever it sits.
  const patch = ["*** Begin Patch", "*** Update File: a.txt", "@@", "-line1", "+line1b", "*** End Patch"];

  for (const marker of ["```", "~~~"]) {
    for (const [name, wrapped] of [
      ["opened and not closed", [marker, ...patch]],
      ["closed and not opened", [...patch, marker]],
      ["opened and closed", [marker, ...patch, marker]],
    ] as const) {
      const root = workspace();
      try {
        seed(root);
        const out = await call(root, wrapped.join("\n"), { "a.txt": sha256(root, "a.txt") });
        assert.equal(out.ok, true, `${marker} ${name}: ${out.ok ? "" : out.error}`);
        assert.match(read(root), /line1b/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }

  const root = workspace();
  try {
    seed(root);
    const out = await call(root, [...patch, "```", "and a sentence about it"].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(out.ok, false, "prose after the closing directive is still not a patch");
    assert.match(out.ok ? "" : out.error, /Unexpected content after/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a fence that was closed more than once is still wrapper", async () => {
  // Closing twice is the same mistake as never closing: it is the wrapper the caller typed, not
  // part of the patch. The second fence used to be read as content after the closing directive,
  // which refused a patch that was otherwise complete.
  const patch = ["*** Begin Patch", "*** Update File: a.txt", "@@", "-line1", "+line1b", "*** End Patch"];

  for (const marker of ["```", "~~~"]) {
    for (const [name, wrapped] of [
      ["opened and closed twice", [marker, ...patch, marker, marker]],
      ["closed twice and never opened", [...patch, marker, marker]],
      ["opened, closed, closed again after a blank line", [marker, ...patch, marker, "", marker]],
    ] as const) {
      const root = workspace();
      try {
        seed(root);
        const out = await call(root, wrapped.join("\n"), { "a.txt": sha256(root, "a.txt") });
        assert.equal(out.ok, true, `${marker} ${name}: ${out.ok ? "" : out.error}`);
        assert.match(read(root), /line1b/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("stripping the wrapper does not relax what a patch has to be", async () => {
  const root = workspace();
  try {
    seed(root);
    const prose = await call(root, "\n\njust some prose\n");
    assert.equal(prose.ok, false);
    assert.match(prose.ok ? "" : prose.error, /must start with/);

    // Content inside the fence but after the closing directive is still not a patch.
    const trailing = await call(root, [
      "```",
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-line1",
      "+line1b",
      "*** End Patch",
      "and that is what I changed",
      "```",
    ].join("\n"), { "a.txt": sha256(root, "a.txt") });
    assert.equal(trailing.ok, false);
    assert.match(trailing.ok ? "" : trailing.error, /Unexpected content after/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the scan stops once a second candidate has settled the answer", () => {
  // A hunk is placed by searching for its lines, and the answer only ever needs one more
  // candidate than the result: a second one means -2 and no third will change that. The scan
  // used to collect every position first, so an ambiguous needle - one line repeated, or an
  // empty needle, which matches at every offset - paid for a full pass and for an array of
  // one candidate per line before anything looked at them. Uniqueness still costs a whole
  // pass, and so does absence: nothing can be called unique before the end of the file.
  let reads = 0;
  const counter = (values: string[]): string[] =>
    new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

  reads = 0;
  assert.equal(findSequence(counter(Array.from({ length: 1_000 }, () => "x")), ["x"], false), -2);
  assert.ok(reads < 10, `an ambiguous needle needs two candidates, not the whole file: ${reads}`);

  reads = 0;
  assert.equal(findSequence(counter(Array.from({ length: 1_000 }, () => "x")), [], false), -2);
  assert.equal(reads, 0, "an empty needle matches at the first offset and the next");

  reads = 0;
  assert.equal(findSequence(counter(Array.from({ length: 1_000 }, (_, index) => `line ${index}`)), ["line 7"], false), 7);
  assert.equal(reads, 1_000, "a unique needle has to be looked for to the end");

  reads = 0;
  assert.equal(findSequence(counter(["a", "b"]), ["zz"], false), -1);
  assert.equal(reads, 2, "and so does one that is nowhere");
});
