export type CanonicalDiffAction = "add" | "update" | "delete" | "move";

export interface CanonicalDiffFile {
  action: CanonicalDiffAction;
  old_path?: string;
  new_path?: string;
  old_bytes?: Uint8Array;
  new_bytes?: Uint8Array;
}

type EditKind = "equal" | "delete" | "insert";

interface LineEdit {
  kind: EditKind;
  line: string;
}

interface AnnotatedEdit extends LineEdit {
  old_line: number;
  new_line: number;
}

interface DecodedLines {
  lines: string[];
  ends_with_newline: boolean;
}

const DEFAULT_CONTEXT_LINES = 3;
// Myers stores a snapshot of the frontier for every edit-distance layer. Keep both
// the number of layers and the total comparison work bounded so a remote patch
// cannot monopolize the extension-host thread or exhaust its heap.
const MAX_MYERS_EDIT_DISTANCE = 512;
const MAX_MYERS_WORK_UNITS = 1_000_000;

function decodeLines(bytes?: Uint8Array): DecodedLines {
  if (!bytes || bytes.byteLength === 0) return { lines: [], ends_with_newline: false };
  const buffer = Buffer.from(bytes);
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const payload = hasBom ? buffer.subarray(3) : buffer;
  const normalized = payload.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const endsWithNewline = normalized.endsWith("\n");
  const body = endsWithNewline ? normalized.slice(0, -1) : normalized;
  // A body that is empty only because the trailing newline was stripped is still one line:
  // "\n" is a file holding one empty line, which is not the same file as "".
  const lines = body.length === 0 ? (endsWithNewline ? [""] : []) : body.split("\n");
  return {
    lines,
    ends_with_newline: endsWithNewline,
  };
}

/**
 * Give every line the newline that follows it.
 *
 * Whether a newline follows a line is part of the line: "a" is not "a\n", and a diff that
 * treats them as equal cannot describe a change between them. Only the last line of a side
 * can be the one without one, so every other line simply gets one appended and the diff then
 * compares whole lines the way git does. Rendering strips it again; the marker that reports a
 * missing newline is written from the file's own state, never from these strings.
 */
function withTrailingNewlines(lines: string[], endsWithNewline: boolean): string[] {
  return lines.map((line, index) => (index === lines.length - 1 && !endsWithNewline ? line : `${line}\n`));
}

function fallbackReplace(oldLines: string[], newLines: string[]): LineEdit[] {
  return [
    ...oldLines.map((line) => ({ kind: "delete" as const, line })),
    ...newLines.map((line) => ({ kind: "insert" as const, line })),
  ];
}

function backtrackMyers(trace: Map<number, number>[], oldLines: string[], newLines: string[]): LineEdit[] {
  let x = oldLines.length;
  let y = newLines.length;
  const edits: LineEdit[] = [];

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const left = v.get(k - 1) ?? Number.NEGATIVE_INFINITY;
    const right = v.get(k + 1) ?? Number.NEGATIVE_INFINITY;
    const previousK = k === -d || (k !== d && left < right) ? k + 1 : k - 1;
    const previousX = v.get(previousK) ?? 0;
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      edits.push({ kind: "equal", line: oldLines[x]! });
    }

    if (d === 0) break;
    if (x === previousX) {
      y -= 1;
      edits.push({ kind: "insert", line: newLines[y]! });
    } else {
      x -= 1;
      edits.push({ kind: "delete", line: oldLines[x]! });
    }
  }

  edits.reverse();
  return edits;
}

function myersDiff(oldLines: string[], newLines: string[]): LineEdit[] {
  if (oldLines.length === 0) return newLines.map((line) => ({ kind: "insert", line }));
  if (newLines.length === 0) return oldLines.map((line) => ({ kind: "delete", line }));

  const max = oldLines.length + newLines.length;
  const maxDistance = Math.min(max, MAX_MYERS_EDIT_DISTANCE);
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Map<number, number>[] = [];
  let workUnits = 0;

  for (let d = 0; d <= maxDistance; d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      workUnits += 1;
      if (workUnits > MAX_MYERS_WORK_UNITS) return fallbackReplace(oldLines, newLines);
      const left = v.get(k - 1) ?? Number.NEGATIVE_INFINITY;
      const right = v.get(k + 1) ?? Number.NEGATIVE_INFINITY;
      let x = k === -d || (k !== d && left < right) ? right : left + 1;
      if (!Number.isFinite(x) || x < 0) x = 0;
      let y = x - k;

      while (x < oldLines.length && y < newLines.length && oldLines[x] === newLines[y]) {
        workUnits += 1;
        if (workUnits > MAX_MYERS_WORK_UNITS) return fallbackReplace(oldLines, newLines);
        x += 1;
        y += 1;
      }
      v.set(k, x);
      if (x >= oldLines.length && y >= newLines.length) return backtrackMyers(trace, oldLines, newLines);
    }
  }

  // Extremely large rewrites can make an exact Myers diff expensive. In that rare case, emit a
  // canonical full replacement for the changed middle; output budgets will still bound the result.
  return fallbackReplace(oldLines, newLines);
}

function diffLines(oldLines: string[], newLines: string[]): LineEdit[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const prefixEdits = oldLines.slice(0, prefix).map((line) => ({ kind: "equal" as const, line }));
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middleEdits = myersDiff(oldMiddle, newMiddle);
  const suffixEdits = suffix > 0
    ? oldLines.slice(oldLines.length - suffix).map((line) => ({ kind: "equal" as const, line }))
    : [];
  return [...prefixEdits, ...middleEdits, ...suffixEdits];
}

function annotateEdits(edits: LineEdit[]): AnnotatedEdit[] {
  let oldLine = 1;
  let newLine = 1;
  return edits.map((edit) => {
    const annotated: AnnotatedEdit = { ...edit, old_line: oldLine, new_line: newLine };
    if (edit.kind !== "insert") oldLine += 1;
    if (edit.kind !== "delete") newLine += 1;
    return annotated;
  });
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** Trailing-newline state for both sides, needed to mark a file that ends without one. */
interface TrailingNewlineState {
  oldLineCount: number;
  newLineCount: number;
  oldEndsWithNewline: boolean;
  newEndsWithNewline: boolean;
}

/**
 * Write one side of a hunk header the way git writes it.
 *
 * A range of exactly one line carries no count - git prints "@@ -1 +1 @@", not
 * "@@ -1,1 +1,1 @@" - while a range of no lines keeps its ",0" so that a pure insertion
 * still says where it landed. Anything else is "start,count".
 */
function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/**
 * Reorder a hunk's edits the way git writes them: within one run of changes, every removed
 * line comes before every added one.
 *
 * The order carries no meaning on its own - a reader reconstructs the old side from the
 * removals and the new side from the additions, and neither is reordered here - but the
 * marker does: it declares a side finished, so anything emitted after it has to belong to
 * neither side. A removal that lands behind the new side's marker is a shape git never
 * writes, and one only this parser understood.
 */
function gitOrdered(edits: AnnotatedEdit[]): AnnotatedEdit[] {
  const out: AnnotatedEdit[] = [];
  let run: AnnotatedEdit[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    out.push(...run.filter((edit) => edit.kind === "delete"));
    out.push(...run.filter((edit) => edit.kind !== "delete"));
    run = [];
  };
  for (const edit of edits) {
    if (edit.kind === "equal") {
      flush();
      out.push(edit);
      continue;
    }
    run.push(edit);
  }
  flush();
  return out;
}

function renderHunks(edits: LineEdit[], trailing: TrailingNewlineState, contextLines = DEFAULT_CONTEXT_LINES): string[] {
  const changeIndices = edits
    .map((edit, index) => (edit.kind === "equal" ? -1 : index))
    .filter((index) => index >= 0);
  if (changeIndices.length === 0) return [];

  const groups: Array<{ start: number; end: number }> = [];
  for (const changeIndex of changeIndices) {
    const start = Math.max(0, changeIndex - contextLines);
    const end = Math.min(edits.length, changeIndex + contextLines + 1);
    const previous = groups.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else groups.push({ start, end });
  }

  const annotated = annotateEdits(edits);
  const output: string[] = [];
  for (const group of groups) {
    const slice = annotated.slice(group.start, group.end);
    const oldCount = slice.filter((edit) => edit.kind !== "insert").length;
    const newCount = slice.filter((edit) => edit.kind !== "delete").length;
    const first = slice[0]!;
    const oldStart = oldCount === 0 ? first.old_line - 1 : first.old_line;
    const newStart = newCount === 0 ? first.new_line - 1 : first.new_line;
    output.push(`@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@`);
    // A run of changes is written the way git writes it: every removed line first, then every
    // added one. Emitting them in the order the diff produced them put a removal *after* the
    // marker that had already declared the new side finished, which is a shape git never
    // writes - and one that only this parser understood.
    for (const edit of gitOrdered(slice)) {
      const marker = edit.kind === "equal" ? " " : edit.kind === "delete" ? "-" : "+";
      // The compared lines carry the newline that follows them; here it is a line break again.
      output.push(`${marker}${edit.line.endsWith("\n") ? edit.line.slice(0, -1) : edit.line}`);
      // Without the marker a reader cannot tell "a\nb" from "a\nb\n", so the diff would
      // understate what changed. Emit it for whichever side ends without a newline. A line
      // that is unchanged carries the same newline on both sides, so one marker covers it.
      if (edit.kind !== "insert" && edit.old_line === trailing.oldLineCount && !trailing.oldEndsWithNewline) {
        output.push(NO_NEWLINE_MARKER);
      } else if (edit.kind !== "delete" && edit.new_line === trailing.newLineCount && !trailing.newEndsWithNewline) {
        output.push(NO_NEWLINE_MARKER);
      }
    }
  }
  return output;
}

function renderFileDiff(file: CanonicalDiffFile): string[] {
  const oldPath = file.old_path ?? file.new_path ?? "unknown";
  const newPath = file.new_path ?? file.old_path ?? "unknown";
  const oldDecoded = decodeLines(file.old_bytes);
  const newDecoded = decodeLines(file.new_bytes);
  const edits = diffLines(
    withTrailingNewlines(oldDecoded.lines, oldDecoded.ends_with_newline),
    withTrailingNewlines(newDecoded.lines, newDecoded.ends_with_newline),
  );
  const hunks = renderHunks(edits, {
    oldLineCount: oldDecoded.lines.length,
    newLineCount: newDecoded.lines.length,
    oldEndsWithNewline: oldDecoded.ends_with_newline,
    newEndsWithNewline: newDecoded.ends_with_newline,
  });
  const output: string[] = [];

  if (file.action === "move") {
    output.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  }
  output.push(
    `--- ${file.action === "add" ? "/dev/null" : `a/${oldPath}`}`,
    `+++ ${file.action === "delete" ? "/dev/null" : `b/${newPath}`}`,
  );
  output.push(...hunks);

  return output;
}

export function createCanonicalUnifiedDiff(files: CanonicalDiffFile[]): string {
  return files.flatMap((file, index) => [
    ...(index > 0 ? [""] : []),
    ...renderFileDiff(file),
  ]).join("\n");
}

