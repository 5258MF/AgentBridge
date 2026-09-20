/**
 * Ignore-file handling for the Node fallback walk.
 *
 * Both file tools walk the tree themselves when ripgrep is unavailable or the caller needs a
 * permission check, and both used to read exactly one .gitignore: the one at the scope root.
 * ripgrep reads every ignore file it walks past, and every one above it, so on any tree whose
 * rules sit anywhere but the root the two engines answered differently - the fallback listed
 * files that ripgrep hid.
 *
 * The rules therefore travel with the walk: each directory contributes the patterns found in its
 * own ignore files, and a pattern is applied to the path relative to the directory it came from,
 * which is what makes `nested/` inside `sub/.gitignore` mean `sub/nested` rather than any
 * `nested` anywhere. Sets are ordered shallow to deep so the deeper file wins, as in git.
 *
 * All three names ripgrep honours are read: .gitignore, .ignore and .rgignore. Reading only
 * .gitignore left the fallback listing files a .ignore had hidden, which is the same disagreement
 * one directory lower down. The names are listed lowest precedence first because the last
 * pattern to match decides, and .rgignore outranks .ignore, which outranks .gitignore.
 *
 * Directories above the walk root count too, which is what `ignoreRulesAbove` is for, and so does
 * the global exclude, which belongs to no directory at all - see `globalIgnoreRules`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { matchesAnyGlob, matchesGlob } from "./glob.js";

/** Lowest precedence first; see the note above. */
export const IGNORE_FILENAMES = [".gitignore", ".ignore", ".rgignore"] as const;

export function isIgnoreFileName(name: string): boolean {
  return (IGNORE_FILENAMES as readonly string[]).includes(name);
}

/** One ignore file: the patterns it holds, and the directory that owns them. */
export type GitignoreRuleSet =
  /**
   * A file inside the walk. `base` is the directory holding it, relative to the walk root in
   * posix form, "" for the root itself, and a pattern is matched against the path relative to
   * that directory.
   */
  | { base: string; patterns: string[] }
  /**
   * A file above the walk root. `above` is the path from the directory holding it down to the
   * walk root, which is what a path inside the walk is prefixed with to be named the way that
   * directory names it.
   */
  | { above: string; patterns: string[] };

/** Ordered shallow to deep. Later entries outrank earlier ones. */
export type GitignoreRules = readonly GitignoreRuleSet[];

/**
 * The patterns in one ignore file.
 *
 * A line beginning with # is a comment and one beginning with ! re-includes, unless the
 * character is escaped with a backslash: git reads `\#report.txt` as a file whose name
 * begins with the character #. The escape stays in the pattern and is undone by the matcher,
 * which has to be able to tell `\!name` from `!name` and can only do that before the escape
 * is gone.
 *
 * A # only opens a comment at the very start of the line - ` #foo` is a pattern naming a file
 * whose name begins with a space - and only unescaped spaces are removed from the end, so
 * `foo\ ` names a file whose name ends with one. Leading spaces are part of the name too:
 * ` build` and `build` are two patterns, and trimming the first made the second match. All of
 * this was checked against `git check-ignore` rather than read off the documentation.
 */
export function parseGitignore(text: string): string[] {
  const patterns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    if (line.startsWith("#")) continue;
    const pattern = trimUnescapedTrailingSpaces(line);
    if (pattern) patterns.push(pattern);
  }
  return patterns;
}

/**
 * The line without the spaces at its end that git would drop.
 *
 * A space git keeps is one that was escaped, and an escape is a backslash that is itself not
 * escaped, so what decides it is whether the run of backslashes in front of the space is odd.
 */
function trimUnescapedTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    for (let index = end - 2; index >= 0 && line[index] === "\\"; index -= 1) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

/** Missing or unreadable means no rules, which is what a directory without a .gitignore means. */
export async function readIgnoreFiles(directory: string): Promise<string[]> {
  const patterns: string[] = [];
  for (const name of IGNORE_FILENAMES) {
    try {
      patterns.push(...parseGitignore(await readFile(path.join(directory, name), "utf8")));
    } catch {
      // A name that is not there, or that cannot be read, contributes nothing.
    }
  }
  return patterns;
}

/**
 * Whether a path written against the workspace root names a directory above it.
 *
 * ".." does and a directory called "..cache" does not: a prefix test read the second as the
 * first and anchored its rules by distance from the walk root instead of by path, which then
 * matched nothing and brought back the files those rules were hiding.
 */
export function isAboveWorkspace(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith("../");
}

/**
 * The rules that apply to a walk from above it.
 *
 * ripgrep reads the ignore files of every directory on the way up, not only the ones it walks
 * past: searching `pkg/` in a tree whose root hides `pkg/secret.txt` answers the same as searching
 * that root, and the walk read none of them - so a scope below the file holding the rules listed
 * what ripgrep had hidden. Same disagreement as a nested file, one level the other way.
 *
 * `displayRoot` is the directory the walk writes its paths against, which is the workspace root
 * and not the walk root whenever the scope is a subdirectory of the workspace. A rule set is
 * classified against that directory, so one found above it is prefixed up to it and one found
 * inside it - still possible, because the walk root can sit below it - is stripped down to it,
 * the way the rules the walk collects itself are. Measuring against the walk root instead puts
 * the scope's own directory in front of every candidate twice, which leaves a pattern carrying a
 * slash anchored a directory too deep, so it matches nothing.
 *
 * Ordered outermost first, so the nearest directory still wins, and the walk appends its own
 * directories after these, which keeps the whole set shallow to deep.
 */
export async function ignoreRulesAbove(walkRoot: string, displayRoot: string): Promise<GitignoreRules> {
  const collected: GitignoreRuleSet[] = [];
  const posix = (value: string): string => value.split(path.sep).join("/");
  const root = path.resolve(displayRoot);
  // The workspace root is where the walk stops climbing. A directory above it belongs to the
  // machine rather than to the workspace the caller opened: a repository holding several
  // folders, or a home directory two levels up, would otherwise reach into a scope that never
  // named it - and an unbounded climb is also what made every call pay for directories it
  // cannot affect. A rule that sits above the root is still classified as one, so a caller
  // that hands in a root below the walk root does not get rules anchored at the wrong depth.
  let directory = path.dirname(path.resolve(walkRoot));
  while (isWithinWorkspace(directory, root)) {
    const patterns = await ignorePatternsIn(directory);
    if (patterns.length > 0) {
      const inside = posix(path.relative(displayRoot, directory));
      // ".." names the parent directory, but "..foo" is an ordinary directory name, and
      // matching the prefix alone read a sibling directory called "..cache" as one above the
      // workspace - its rules were then applied at the wrong distance and matched nothing.
      collected.push(isAboveWorkspace(inside)
        ? { above: posix(path.relative(directory, displayRoot)), patterns }
        : { base: inside, patterns });
    }
    if (sameDirectory(directory, root)) break;
    directory = path.dirname(directory);
  }
  return collected.reverse();
}

/** Whether `directory` is the workspace root itself or sits below it. */
function isWithinWorkspace(directory: string, root: string): boolean {
  if (sameDirectory(directory, root)) return true;
  const relative = path.relative(root, directory);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Two spellings of one directory, which on Windows and macOS differ only in case. */
function sameDirectory(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  const foldsCase = process.platform === "win32" || process.platform === "darwin";
  return foldsCase && a.toLowerCase() === b.toLowerCase();
}

/**
 * The ignore files of one directory, read once.
 *
 * Every `find_files` and `search_files` call walked from the scope up to the workspace root and
 * read each directory on the way, so a scope three levels down paid for the same three files on
 * every call, and every call in a search paid for all of them again. These files are inside the
 * workspace now - the climb stops at its root - so they change when the workspace does, and a
 * change is picked up the way the rest of the configuration is, when the window is reloaded.
 *
 * Keyed by the directory, so a walk that climbs past a directory another walk already
 * read, and one that descends into it again, share what they read.
 */
const directoryIgnoreCache = new Map<string, string[]>();

async function ignorePatternsIn(directory: string): Promise<string[]> {
  const key = path.resolve(directory);
  const cached = directoryIgnoreCache.get(key);
  if (cached) return cached;
  const patterns = await readIgnoreFiles(directory);
  if (directoryIgnoreCache.size >= 512) directoryIgnoreCache.clear();
  directoryIgnoreCache.set(key, patterns);
  return patterns;
}

/** Forget every directory's ignore files, so the next call reads them again. */
export function clearIgnoreCache(): void {
  directoryIgnoreCache.clear();
}

/** The environment the global exclude is resolved from; process.env everywhere but the tests. */
export type IgnoreEnvironment = Record<string, string | undefined>;

function homeDirectory(env: IgnoreEnvironment): string | undefined {
  return env.HOME || env.USERPROFILE;
}

/** Where git keeps its configuration under, which is also where the default exclude lives. */
function configHome(env: IgnoreEnvironment): string | undefined {
  const home = homeDirectory(env);
  return env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : undefined);
}

/**
 * The config files git would look in, in the order it reads them. An explicit GIT_CONFIG_GLOBAL
 * replaces the per-user files rather than joining them, which is what git does.
 */
function configCandidates(env: IgnoreEnvironment): string[] {
  if (env.GIT_CONFIG_GLOBAL) return [env.GIT_CONFIG_GLOBAL];
  const home = homeDirectory(env);
  const xdg = configHome(env);
  return [
    home ? path.join(home, ".gitconfig") : undefined,
    xdg ? path.join(xdg, "git", "config") : undefined,
  ].filter((value): value is string => Boolean(value));
}

/** The value `section.key` has in one git config file, or undefined when it does not set it.
 *
 * This is the smallest reading that finds `core.excludesFile`, not a config parser: include and
 * includeIf are not followed, the system config is not read, `~user/` and escaped characters
 * inside a quoted value are not expanded. A subsection - `[core "x"]` - is read as the section
 * alone, which is what makes `[remote "origin"]` line up with `remote`; git rejects a subsection
 * on `core` anyway, so the one section looked up here has nothing to lose by it.
 */
async function configValue(config: string, section: string, key: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(config, "utf8");
  } catch {
    return undefined;
  }
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]*)\]$/.exec(line);
    if (header) {
      current = (header[1] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      continue;
    }
    if (current !== section) continue;
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!entry || (entry[1] ?? "").toLowerCase() !== key) continue;
    const value = (entry[2] ?? "").trim().replace(/^"(.*)"$/, "$1");
    if (value) return value;
  }
  return undefined;
}

function expandHome(value: string, env: IgnoreEnvironment): string {
  const home = homeDirectory(env);
  if (!home) return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}

/** One ignore file, read directly; `above` is how it names a path inside the walk. */
async function ignoreRulesFromFile(file: string, above = ""): Promise<GitignoreRules> {
  try {
    const patterns = parseGitignore(await readFile(file, "utf8"));
    return patterns.length > 0 ? [{ above, patterns }] : [];
  } catch {
    return [];
  }
}

/**
 * The global exclude file, which ripgrep applies in every directory.
 *
 * git keeps it wherever core.excludesFile points and otherwise at $XDG_CONFIG_HOME/git/ignore,
 * which is ~/.config/git/ignore. ripgrep reads it inside a repository and outside one, so a
 * machine with a global ignore answered differently from the same tree without one, and the
 * walking engine read none of it.
 *
 * Only that one key is looked for, and only in the per-user files: include directives and the
 * system config are not followed, which is the one thing this does not do that git does.
 */
/**
 * The global exclude, read once for the lifetime of the process.
 *
 * Every `find_files` and `search_files` call used to read the per-user git config and then the
 * file it names from the beginning, so a walk paid for the same two files on every call. They
 * are the user's configuration, not the repository's: a change to them is picked up when the
 * window is reloaded, which is how the rest of the configuration behaves.
 *
 * The directories the walk climbs through are kept the same way now that the climb stops at the
 * workspace root - see `ignorePatternsIn`.
 */
const globalIgnoreCache = new Map<string, GitignoreRules>();

export async function globalIgnoreRules(env: IgnoreEnvironment = process.env): Promise<GitignoreRules> {
  const key = globalIgnoreKey(env);
  const cached = globalIgnoreCache.get(key);
  if (cached) return cached;
  const rules = await readGlobalIgnoreRules(env);
  if (globalIgnoreCache.size >= 8) globalIgnoreCache.clear();
  globalIgnoreCache.set(key, rules);
  return rules;
}

/** What the answer depends on: the environment decides where those two files are. */
function globalIgnoreKey(env: IgnoreEnvironment): string {
  return [env.GIT_CONFIG_GLOBAL ?? "", env.HOME ?? "", env.USERPROFILE ?? "", env.XDG_CONFIG_HOME ?? ""].join("\u0000");
}

async function readGlobalIgnoreRules(env: IgnoreEnvironment): Promise<GitignoreRules> {
  for (const config of configCandidates(env)) {
    const named = await configValue(config, "core", "excludesfile");
    if (named) return ignoreRulesFromFile(expandHome(named, env));
  }
  const home = configHome(env);
  return home ? ignoreRulesFromFile(path.join(home, "git", "ignore")) : [];
}

/**
 * Every rule that applies to a walk root without living inside it: the global exclude, then the
 * directories above, nearest last so that a file closer to the walk still wins.
 */
export async function ignoreRulesOutside(
  walkRoot: string,
  displayRoot: string,
  env: IgnoreEnvironment = process.env,
): Promise<GitignoreRules> {
  return [...(await globalIgnoreRules(env)), ...(await ignoreRulesAbove(walkRoot, displayRoot))];
}

/**
 * Rules for a directory being descended into, appended to whatever the parents contributed.
 * Returns the parent array unchanged when the directory holds no ignore file, so a tree without
 * nested ignore files allocates nothing per level.
 */
export async function extendGitignoreRules(
  parent: GitignoreRules,
  directory: string,
  rootRelativeDirectory: string,
): Promise<GitignoreRules> {
  const patterns = await ignorePatternsIn(directory);
  if (patterns.length === 0) return parent;
  return [...parent, { base: rootRelativeDirectory, patterns }];
}

/**
 * A leading "!" re-includes, and a trailing "/" restricts the pattern to directories; both
 * are handled by expanding the pattern into the forms a path can take here. A bare name is
 * what git calls "any file or directory with this name at any depth", so `docs` also
 * matches `a/b/docs`.
 *
 * `isDirectory` is what a pattern ending in "/" is asking about: git hides the directory
 * and everything under it, and not a file that happens to carry the same name. Such a
 * pattern is tried against each directory the path passes through - and against the path
 * itself only when the path is a directory - rather than against the path as a whole.
 */
function patternMatches(candidate: string, raw: string, isDirectory: boolean): boolean {
  const negated = raw.startsWith("!");
  // Undone after a leading "!" has been taken off, so that `\!keep.txt` - a file whose
  // name begins with the character ! - is not read as a re-include of keep.txt.
  let body = negated ? raw.slice(1) : raw;
  // Whether the pattern is tied to this directory is decided before any escape is undone: a
  // leading "/" anchors it, while `\/` is a name that begins with the character / and is not
  // an anchor at all. Undoing the escape first turned the second into the first.
  // Remembered rather than dropped: what the slash takes away from the name it still says
  // about the pattern, and that is what the variants below are chosen on.
  const anchored = body.startsWith("/");
  if (anchored) body = body.slice(1);
  // One pass for the rest. A backslash escapes what follows it, and what follows then stands
  // for itself - including another backslash, which used to be turned into a separator on a
  // second pass, and including a "/", which is a character in a name rather than a separator.
  // A backslash with nothing after it is the separator, which is what an unescaped one is.
  const source = body.replace(/\\(.)|\\/g, (_match, escaped: string | undefined) => escaped ?? "/");
  if (!source) return false;
  const directoryOnly = source.endsWith("/");
  const clean = directoryOnly ? source.slice(0, -1) : source;
  if (!clean) return false;
  // A leading "/" ties a pattern to the directory holding the ignore file, and so does a
  // separator inside it - git anchors both - so neither becomes "at any depth". Only a bare
  // name does: `git check-ignore` answers no for `a/deep` with `/deep` in the file, and yes
  // for it with `deep` in the file. The slash used to be taken off and then forgotten, so an
  // anchored pattern was matched at every depth.
  // What is under an anchored directory is hidden with it - `git check-ignore` answers yes for
  // `deep/f.txt` with `/deep` in the file - so the anchored form keeps a `/**` of its own. The
  // walk usually stops at the directory before it ever asks about a file inside one, but a rule
  // from above the walk names the whole walk, and then the files underneath are all it is
  // ever asked about.
  const variants = anchored || clean.includes("/")
    ? [clean, `${clean}/**`]
    : [clean, `**/${clean}`, `**/${clean}/**`];
  // An anchored pattern is matched against the path and against nothing else. matchesAnyGlob
  // also offers the basename, and that is exactly what "at any depth" means - which is exactly
  // what an anchored pattern is not: with `deep` as the variant it answers yes for `a/deep`.
  const hit = (value: string): boolean =>
    anchored
      ? variants.some((variant) => matchesGlob(value, variant))
      : matchesAnyGlob(value, variants, true);
  if (!directoryOnly) return hit(candidate);
  const segments = candidate.split("/");
  const depths = isDirectory ? segments.length : segments.length - 1;
  for (let depth = 1; depth <= depths; depth += 1) {
    if (hit(segments.slice(0, depth).join("/"))) return true;
  }
  return false;
}

/** The candidate as the owning directory would name it, or undefined when it is not underneath. */
function localCandidate(rootRelative: string, set: GitignoreRuleSet): string | undefined {
  if ("above" in set) {
    // Every path inside the walk gets the same prefix, because the rule's directory holds the
    // whole walk. A file that belongs to no directory - the global exclude - adds none.
    return set.above ? `${set.above}/${rootRelative}` : rootRelative;
  }
  if (!set.base) return rootRelative;
  const prefix = `${set.base}/`;
  return rootRelative.startsWith(prefix) ? rootRelative.slice(prefix.length) : undefined;
}

/**
 * Whether the walk should skip this path. `rootRelative` is the path from the walk root in posix
 * form; the last matching pattern decides, which is what lets a nested .gitignore re-include
 * something a parent excluded.
 * `isDirectory` is only consulted by a pattern ending in "/"; see patternMatches.
 */
export function gitignoreIgnores(
  rootRelative: string,
  rules: GitignoreRules,
  isDirectory = false,
): boolean {
  if (rules.length === 0) return false;
  const candidate = rootRelative.replace(/\\/g, "/");
  let ignored = false;
  for (const set of rules) {
    const local = localCandidate(candidate, set);
    if (local === undefined) continue;
    for (const raw of set.patterns) {
      if (patternMatches(local, raw, isDirectory)) ignored = !raw.startsWith("!");
    }
  }
  return ignored;
}
