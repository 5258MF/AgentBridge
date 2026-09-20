/**
 * Glob matching for the file tools.
 *
 * Matching is Node's own `path.matchesGlob`, which arrived in Node 22.5.0 and 20.17.0.
 *
 * Every host this extension can land on has it. `engines.vscode` starts at VS Code 1.95,
 * which ships Electron 32 carrying Node 20.18.0, and package.json contributes no `browser`
 * entry and pins `extensionKind` to "workspace", so the extension host is that Node rather
 * than a web worker with a shimmed `path` module. Two earlier commits read the same facts
 * the other way and replaced this delegation with a hand-rolled matcher; the versions here
 * are what VS Code 1.95's release notes and Node's changelog say.
 *
 * The module still earns its keep as the single place that decides what a glob means here — the callers used to reach for `path.matchesGlob` directly and
 * each wrapped it in a try/catch that answered a bad pattern differently.
 */
import path from "node:path";

export function matchesGlob(value: string, pattern: string): boolean {
  try {
    return path.matchesGlob(value, pattern);
  } catch {
    // Node reads a malformed pattern as a literal rather than as an error, so this is only
    // reached by an argument of the wrong type. A pattern that cannot be evaluated matches
    // nothing, which is the same answer ripgrep's globset gives one it cannot apply.
    return false;
  }
}

/**
 * Whether any pattern matches, the way ripgrep reads a glob.
 *
 * A pattern written without a slash names an entry by its own name — both ripgrep and
 * .gitignore read it that way — so the basename is tested alongside the whole path. "docs"
 * is how you say "everything under docs", and matching it only against the full path left a
 * walk that descended into the directory and then kept every file it found there. Testing the
 * basename is also what lets a directory be pruned instead of filtered file by file.
 *
 * The case to match in has no default: every caller has to say which one it means. Two of the
 * four callers here want the sensitive match and two do not, and a default made the two that
 * wanted the other one look like an oversight - one was found by reading the call, not by the
 * compiler.
 */
export function matchesAnyGlob(value: string, patterns: readonly string[], caseSensitive: boolean): boolean {
  if (patterns.length === 0) return false;
  const normalized = value.split(path.sep).join("/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return patterns.some((pattern) => {
    if (caseSensitive) return matchesGlob(normalized, pattern) || matchesGlob(base, pattern);
    // Not matched by lowering both sides to one case: that rewrites the pattern, and a pattern
    // is not text - `[A-z]` is a range that reaches `[`, `\\`, `]`, `^` and `_`, and lowering it
    // turns it into `[a-z]`, which reaches none of them. ripgrep answers `[A-z]` with `[`, so
    // one exclude was hiding different files in the two engines. The pattern is compiled
    // instead, and every case in the test was checked against `rg --iglob`.
    const glob = insensitiveGlob(pattern);
    if (!glob) return false;
    return glob.test(normalized) || glob.test(base);
  });
}

/**
 * One glob, compiled to a pattern that matches without regard to case.
 *
 * `path.matchesGlob` takes no options and has no case-insensitive form, so a caller asking for
 * one is answered by compiling the glob instead. The compiler is only ever used for that: a
 * case-sensitive match still goes to the host, which is what decides what a glob means here.
 * The compiled forms are kept, because a walk asks about the same few patterns once per file.
 */
const insensitiveGlobs = new Map<string, RegExp | null>();

function insensitiveGlob(pattern: string): RegExp | null {
  const cached = insensitiveGlobs.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(`^${globToRegExp(pattern)}$`, "i");
  } catch {
    // A pattern that cannot be compiled matches nothing, which is the same answer the host
    // gives for one it cannot apply.
    compiled = null;
  }
  if (insensitiveGlobs.size >= 256) insensitiveGlobs.clear();
  insensitiveGlobs.set(pattern, compiled);
  return compiled;
}

/**
 * A glob, as the regular expression it stands for.
 *
 * The expression is only built for a case-insensitive match, and it is built from a glob that
 * arrived in settings.json or in a tool argument, never from the contents of a file, so there
 * is no ReDoS guard here: every piece it emits reads the input once and none of them nests one
 * quantifier inside another for a hostile pattern to drive. What it has to get right is
 * meaning. It is the only place a case-insensitive match is decided, and that answer has to
 * agree with the case-sensitive one the host would have given for the same glob.
 * `tests/glob-match.test.ts` puts the two side by side.
 */
function globToRegExp(pattern: string): string {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    // An escape stands for the character it escapes, so a "\\*" is a star and not a wildcard
    // and a "\\," inside a brace is a comma in one branch rather than the mark between two.
    if (char === "\\" && index + 1 < pattern.length) {
      source += literal(pattern[index + 1]!);
      index += 2;
      continue;
    }
    if (char === "*") {
      let stars = 0;
      while (pattern[index + stars] === "*") stars += 1;
      // "**" is a globstar only when it is a path segment of its own: "**", "**/b", "a/**" and
      // "a/**/b". Everywhere else it is the two single stars it looks like, and a single star
      // never crosses a "/". The host reads it that way: it answers "a**b" with "ab" and with
      // "axb" but not with "a/b", which an unconditional ".*" took in as well.
      const segment =
        stars === 2 &&
        (index === 0 || pattern[index - 1] === "/") &&
        (index + stars >= pattern.length || pattern[index + stars] === "/");
      index += stars;
      if (!segment) {
        source += "[^/]*";
        continue;
      }
      // A globstar in the middle stands for any number of directories, none of them included:
      // "a/**/b" reaches "a/b" too. The "/" that follows it is repeated with each directory.
      if (index < pattern.length) {
        index += 1;
        source += "(?:[^/]+/)*";
      } else {
        // A globstar at the end still needs the directory it stands behind: the host answers
        // "a/**" with "a/b" and with "a/", but not with "a".
        source += ".*";
      }
      continue;
    }
    if (char === "?") {
      index += 1;
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const bracket = bracketClass(pattern, index);
      index = bracket[1];
      source += bracket[0];
      continue;
    }
    if (char === "{") {
      const alternation = braceAlternation(pattern, index);
      index = alternation[1];
      source += alternation[0];
      continue;
    }
    index += 1;
    source += literal(char);
  }
  return source;
}

/** A bracket expression, or the character "[" when the one that opened it is never closed. */
function bracketClass(pattern: string, index: number): [string, number] {
  let cursor = index + 1;
  let negated = false;
  // "!" is the negation a glob writes. "^" is not one, but the host reads it as one and so
  // does ripgrep, and this compiler exists only to give the answer the host would give: a
  // class that read "^" as an ordinary member would hide different files in the two engines.
  // Anywhere but first, "^" is an ordinary member - the host answers "^" for "[a^]".
  if (pattern[cursor] === "!" || pattern[cursor] === "^") {
    negated = true;
    cursor += 1;
  }
  let body = "";
  // A "]" in the first position is a member of the class rather than the end of it: the host
  // answers "]" for "[]a]", so the class has to hold it. It is escaped rather than left where
  // it is, because a negated class already has a "^" in the position a leading "]" would have
  // to keep.
  if (pattern[cursor] === "]") {
    body += "\\]";
    cursor += 1;
  }
  while (cursor < pattern.length && pattern[cursor] !== "]") {
    body += pattern[cursor] === "\\" ? "\\\\" : pattern[cursor];
    cursor += 1;
  }
  if (cursor >= pattern.length) return [literal("["), index + 1];
  return [`[${negated ? "^" : ""}${body}]`, cursor + 1];
}

/**
 * A brace alternation, or the character "{" when the one that opened it is never closed.
 *
 * A character class is not split at the comma inside it: `{[a,b]}` names a, b or the comma
 * itself, which is what the host reads, and scanning it as bare characters would turn it into
 * the three branches `[a`, `b]` - a pattern that matches neither. An escaped comma is a comma
 * in one branch for the same reason.
 */
function braceAlternation(pattern: string, index: number): [string, number] {
  const branches: string[] = [];
  let current = "";
  let depth = 0;
  let cursor = index;
  let inClass = false;
  let classJustOpened = false;
  while (cursor < pattern.length) {
    const char = pattern[cursor]!;
    if (char === "\\") {
      current += char;
      cursor += 1;
      if (cursor < pattern.length) {
        current += pattern[cursor];
        cursor += 1;
      }
      continue;
    }
    if (inClass) {
      current += char;
      cursor += 1;
      // "[]abc]" and "[!abc]" open with a character that is part of the class, so only a
      // later "]" closes it.
      if (char === "]" && !classJustOpened) inClass = false;
      classJustOpened = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      classJustOpened = true;
      current += char;
      cursor += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
      if (depth === 1) {
        cursor += 1;
        continue;
      }
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        branches.push(globToRegExp(current));
        return [`(?:${branches.join("|")})`, cursor + 1];
      }
    } else if (char === "," && depth === 1) {
      branches.push(globToRegExp(current));
      current = "";
      cursor += 1;
      continue;
    }
    current += char;
    cursor += 1;
  }
  return [literal("{"), index + 1];
}

function literal(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether ripgrep refused the invocation rather than the search.
 *
 * A fatal ripgrep exit covers two very different things. One is "this build cannot run the
 * query": an older or stripped-down binary that does not know one of the flags these tools
 * pass, which is worth answering by trying the next binary - the bundled ripgrep is only
 * the first of several candidates, and a machine whose copy will not start searching at all
 * still has a ripgrep on PATH and a Node engine behind it. The other is "the search failed":
 * an unreadable path, or a glob that a caller or settings.json supplied. That is an answer
 * about the query, and quietly replacing it with a slower engine that does not read globs
 * the same way would hide it - a rejected exclude is exactly the file the user asked never
 * to be shown.
 */
export function isRipgrepUsageError(stderr: string): boolean {
  return /unrecognized|unknown flag|wasn't expected|unexpected argument|invalid value|required argument|usage:/i.test(stderr);
}

/**
 * Whether ripgrep will accept the pattern. Node's own matcher is lenient — it reads "[", "{"
 * and a trailing "\" as literals — while ripgrep parses globs with globset and exits with an
 * error on an unclosed character class, an unbalanced alternate group or a dangling escape.
 * One such pattern, in a tool call or in settings.json, fails every search that follows it.
 */
export function isSupportedGlob(glob: string): boolean {
  if (!glob || glob.length > 4_000) return false;
  let inClass = false;
  let groupDepth = 0;
  let escaped = false;
  for (const char of glob) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      // Everything up to the closing "]" is a member of the class, "[" included.
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "{") groupDepth += 1;
    else if (char === "}") {
      if (groupDepth === 0) return false;
      groupDepth -= 1;
    }
  }
  return !escaped && !inClass && groupDepth === 0;
}
