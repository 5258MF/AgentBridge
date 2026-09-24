/**
 * Plan mode command policy for run_command.
 *
 * In Plan mode the model may inspect the project with commands but must not change it, so
 * every command is checked against an allowlist before it reaches the shell. The idea follows
 * the plan-mode example extension of the pi coding agent (github.com/badlogic/pi-mono, MIT),
 * made stricter for AgentBridge:
 * - pi only matches the start of the command, so `git status; rm -rf src` passed. Here every
 *   segment of a pipeline or command list must be allowlisted on its own.
 * - Shell syntax that can run or write something regardless of the command name is rejected:
 *   redirection, command substitution, subexpressions, script blocks, and background jobs.
 * - Managed shells are PowerShell or POSIX shells, so both command families are covered.
 *
 * The check is deliberately conservative. It may reject a harmless command; the error tells the
 * model what is allowed so it can pick an alternative or leave the command for the Build phase.
 */

export type PlanModeCommandCheck = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Command names quoted in the model-facing summary; tests check that each one is allowlisted. */
export const PLAN_MODE_SUMMARY_INSPECT_COMMANDS = ["Get-Content", "Select-String", "Get-ChildItem", "cat", "rg", "ls"] as const;
export const PLAN_MODE_SUMMARY_GIT_COMMANDS = ["status", "log", "diff", "show", "blame", "grep"] as const;
/** Complete example commands quoted in the summary; tests run each one through the checker. */
export const PLAN_MODE_SUMMARY_CHECK_COMMANDS = ["npm test", "npm run build", "npx tsc --noEmit"] as const;

/** One-line description of what run_command accepts in Plan mode, for instructions and errors. */
export const PLAN_MODE_COMMAND_SUMMARY =
  `file inspection and search (for example ${PLAN_MODE_SUMMARY_INSPECT_COMMANDS.join(", ")}), `
  + `read-only git (${PLAN_MODE_SUMMARY_GIT_COMMANDS.join(", ")}, and listing branches, tags, remotes, and stashes), `
  + `and project tests, builds, and type checks (${PLAN_MODE_SUMMARY_CHECK_COMMANDS.join(", ")}, and the pnpm, yarn, cargo, go, and pytest equivalents)`;

type Rule = (args: readonly string[]) => string | undefined;

const ok: Rule = () => undefined;

function isFlag(word: string): boolean {
  return word.startsWith("-") && word.length > 1;
}

function positionals(args: readonly string[]): string[] {
  return args.filter((word) => !isFlag(word));
}

/**
 * Reject any of the given flags, with or without an attached value (`--output=x`, `-ofile`).
 * Short `-x` flags are case-sensitive (git grep -o is harmless, -O runs a pager); long flags and
 * Windows `/x` switches are not.
 */
function forbidFlags(...flags: string[]): Rule {
  return (args) => {
    for (const word of args) {
      for (const flag of flags) {
        const caseless = flag.startsWith("--") || flag.startsWith("/");
        const candidate = caseless ? word.toLowerCase() : word;
        const shortFlag = flag.length === 2 && !flag.startsWith("--");
        const hit = candidate === flag
          || (flag.startsWith("--") && candidate.startsWith(`${flag}=`))
          || (shortFlag && candidate.startsWith(flag) && !candidate.startsWith("--"));
        if (hit) return `${word} is not allowed in Plan mode`;
      }
    }
    return undefined;
  };
}

function all(...rules: Rule[]): Rule {
  return (args) => {
    for (const rule of rules) {
      const reason = rule(args);
      if (reason) return reason;
    }
    return undefined;
  };
}

/** Read-only commands. Some take flags that write files or run programs; those are rejected. */
const READ_COMMANDS: Record<string, Rule> = {
  // POSIX
  cat: ok, head: ok, tail: ok, grep: ok, egrep: ok, fgrep: ok, ls: ok, pwd: ok, echo: ok, printf: ok,
  wc: ok, diff: ok, cmp: ok, comm: ok, cut: ok, tr: ok, nl: ok, column: ok, file: ok, stat: ok,
  du: ok, df: ok, which: ok, whereis: ok, type: ok, whoami: ok, id: ok, uname: ok, uptime: ok,
  basename: ok, dirname: ok, realpath: ok, readlink: ok, jq: ok, bat: ok, eza: ok, printenv: ok,
  ps: ok, free: ok, md5sum: ok, sha1sum: ok, sha256sum: ok, od: ok, hexdump: ok,
  rg: forbidFlags("--pre"),
  sort: forbidFlags("-o", "--output", "/o"),
  uniq: (args) => (positionals(args).length > 1 ? "uniq with an output file is not allowed in Plan mode" : undefined),
  tree: forbidFlags("-o"),
  date: forbidFlags("-s", "--set"),
  hostname: (args) => (positionals(args).length > 0 ? "setting the host name is not allowed in Plan mode" : undefined),
  find: forbidFlags("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"),
  fd: forbidFlags("-x", "--exec", "-X", "--exec-batch"),
  // PowerShell cmdlets and their built-in aliases (ls, cat, echo, pwd, diff, sort, type also map here)
  "get-content": ok, gc: ok, "select-string": ok, sls: ok, "get-childitem": ok, gci: ok, dir: ok,
  "get-item": ok, gi: ok, "get-itemproperty": ok, gp: ok, "get-location": ok, gl: ok,
  "test-path": ok, "resolve-path": ok, rvpa: ok, "split-path": ok, "join-path": ok,
  "measure-object": ok, measure: ok, "select-object": ok, select: ok, "where-object": ok, where: ok,
  "sort-object": ok, "group-object": ok, group: ok, "get-unique": ok,
  "format-table": ok, ft: ok, "format-list": ok, fl: ok, "format-wide": ok, fw: ok,
  "out-string": ok, "out-host": ok, oh: ok, "get-filehash": ok, "get-command": ok, gcm: ok,
  "get-date": ok, "get-process": ok, gps: ok, "get-uptime": ok, "write-output": ok, write: ok, "write-host": ok,
  "compare-object": ok, compare: ok, "convertfrom-json": ok, "convertto-json": ok, "get-member": ok, gm: ok,
};

const GIT_READ_SUBCOMMANDS: Record<string, Rule> = {
  status: ok, log: ok, diff: ok, show: ok, blame: ok, annotate: ok, shortlog: ok, describe: ok,
  "rev-parse": ok, "rev-list": ok, "ls-files": ok, "ls-tree": ok, "ls-remote": ok, "cat-file": ok,
  "show-ref": ok, "for-each-ref": ok, "merge-base": ok, "name-rev": ok, "count-objects": ok, whatchanged: ok,
  grep: forbidFlags("-O", "--open-files-in-pager"),
  branch: listOnly(
    ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force", "-u", "--set-upstream-to", "--unset-upstream", "--edit-description", "-t", "--track", "--no-track"],
    ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
  ),
  tag: listOnly(
    ["-a", "--annotate", "-s", "--sign", "-u", "--local-user", "-f", "--force", "-d", "--delete", "-m", "--message", "-F", "--file", "-e", "--edit"],
    ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
  ),
  remote: (args) => {
    const [sub, ...rest] = positionals(args);
    if (sub === undefined || sub === "show" || sub === "get-url") return undefined;
    return `git remote ${sub}${rest.length ? " ..." : ""} is not allowed in Plan mode`;
  },
  stash: (args) => (["list", "show"].includes(args[0] ?? "") ? undefined : "only git stash list and git stash show are allowed in Plan mode"),
  worktree: (args) => (args[0] === "list" ? undefined : "only git worktree list is allowed in Plan mode"),
  reflog: (args) => (["expire", "delete"].includes(args[0] ?? "") ? `git reflog ${args[0]} is not allowed in Plan mode` : undefined),
  config: (args) => {
    const scopes = ["--global", "--local", "--system", "--worktree", "--show-origin", "--show-scope"];
    const reading = args.some((word) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(word))
      || ["get", "list"].includes(args[0] ?? "")
      || (positionals(args).length === 1 && args.every((word) => !isFlag(word) || scopes.includes(word)));
    return reading ? undefined : "only reading git config (--get, --get-all, --get-regexp, --list) is allowed in Plan mode";
  },
};

/**
 * branch and tag both create or delete refs when given a name, and only list refs otherwise.
 * Positional arguments are accepted only as patterns in listing mode.
 */
function listOnly(mutatingFlags: readonly string[], listingFlags: readonly string[]): Rule {
  const mutating = new Set(mutatingFlags);
  return (args) => {
    for (const word of args) {
      const name = word.split("=")[0];
      if (mutating.has(name)) return `${word} is not allowed in Plan mode`;
    }
    const listing = args.some((word) => listingFlags.includes(word.split("=")[0]));
    return positionals(args).length > 0 && !listing ? "creating a branch or tag is not allowed in Plan mode; add --list to list matching names" : undefined;
  };
}

function gitRule(args: readonly string[]): string | undefined {
  let index = 0;
  // Global options: only -C <dir> and --no-pager. `-c key=value` and friends can make git run programs.
  while (index < args.length && isFlag(args[index])) {
    if (args[index] === "--no-pager" || args[index] === "--version") {
      index += 1;
    } else if (args[index] === "-C" && index + 1 < args.length) {
      index += 2;
    } else {
      return `git option ${args[index]} is not allowed in Plan mode`;
    }
  }
  const sub = args[index];
  if (sub === undefined) return args.includes("--version") ? undefined : "git needs a read-only subcommand";
  const rule = GIT_READ_SUBCOMMANDS[sub.toLowerCase()];
  if (!rule) return `git ${sub} is not allowed in Plan mode`;
  const rest = args.slice(index + 1);
  if (rest.some((word) => word.toLowerCase().startsWith("--output"))) return "--output is not allowed in Plan mode";
  return rule(rest);
}

/** Script names that run tests, builds, or type checks. Lint scripts are excluded because they often fix files. */
const CHECK_SCRIPT = /^(test|build|typecheck|type-check)([:._-][\w:.-]*)?$/i;

function packageManagerRule(name: string, readSubcommands: readonly string[]): Rule {
  return (args) => {
    const [sub, ...rest] = args;
    if (sub === undefined) return `${name} needs a subcommand`;
    const lower = sub.toLowerCase();
    if (lower === "-v" || lower === "--version") return undefined;
    if (lower === "test" || lower === "t" || lower === "tst") return undefined;
    if (lower === "run" || lower === "run-script") {
      const script = positionals(rest)[0];
      if (script && CHECK_SCRIPT.test(script)) return undefined;
      return `${name} run ${script ?? ""}`.trim() + " is not allowed in Plan mode; only test, build, and typecheck scripts can run";
    }
    if (lower === "audit") return rest.some((word) => word === "fix" || word === "--fix") ? `${name} audit fix is not allowed in Plan mode` : undefined;
    if (lower === "config") return ["get", "list", "ls"].includes(rest[0] ?? "") ? undefined : `only reading ${name} config is allowed in Plan mode`;
    if (lower === "pkg") return rest[0] === "get" ? undefined : `only ${name} pkg get is allowed in Plan mode`;
    if (readSubcommands.includes(lower)) return undefined;
    return `${name} ${sub} is not allowed in Plan mode`;
  };
}

function tscRule(args: readonly string[]): string | undefined {
  if (args.some((word) => ["-v", "--version"].includes(word))) return undefined;
  if (!args.some((word) => word.toLowerCase() === "--noemit")) return "tsc is only allowed with --noEmit in Plan mode";
  return forbidFlags("-b", "--build", "-w", "--watch", "--init")(args);
}

const COMMANDS: Record<string, Rule> = {
  ...READ_COMMANDS,
  git: gitRule,
  npm: packageManagerRule("npm", ["ls", "list", "ll", "la", "view", "v", "info", "show", "outdated", "explain", "why", "root", "prefix", "query"]),
  pnpm: packageManagerRule("pnpm", ["ls", "list", "ll", "why", "outdated", "root"]),
  yarn: packageManagerRule("yarn", ["list", "info", "why", "outdated"]),
  tsc: tscRule,
  npx: (args) => (args[0]?.toLowerCase() === "tsc" ? tscRule(args.slice(1)) : "npx is only allowed for tsc --noEmit in Plan mode"),
  cargo: (args) => {
    const sub = args[0]?.toLowerCase();
    if (sub === "clippy") return forbidFlags("--fix")(args.slice(1));
    return sub && ["test", "check", "build", "tree", "metadata", "--version", "-v"].includes(sub) ? undefined : `cargo ${args[0] ?? ""}`.trim() + " is not allowed in Plan mode";
  },
  go: (args) => {
    const sub = args[0]?.toLowerCase();
    if (sub === "env") return args.slice(1).some((word) => ["-w", "-u"].includes(word)) ? "changing go env is not allowed in Plan mode" : undefined;
    return sub && ["test", "vet", "build", "list", "version"].includes(sub) ? undefined : `go ${args[0] ?? ""}`.trim() + " is not allowed in Plan mode";
  },
  pytest: ok,
  python: pythonRule,
  python3: pythonRule,
  py: pythonRule,
  node: (args) => (args.length === 1 && ["-v", "--version"].includes(args[0]) ? undefined : "node is only allowed with --version in Plan mode"),
};

function pythonRule(args: readonly string[]): string | undefined {
  if (args.length === 1 && ["-V", "--version"].includes(args[0])) return undefined;
  if (args[0] === "-m" && args[1] === "pytest") return undefined;
  return "python is only allowed for --version and -m pytest in Plan mode";
}

type Token = { readonly sep: false; readonly word: string } | { readonly sep: true };

/** Stderr/stdout discards that cannot write a file: 2>&1, *>&1, 2>/dev/null, 2>$null, 2>nul, >$null. */
const DISCARD_TARGET = /^(&1|\$null|\/dev\/null|nul)(?=$|[\s;|&])/i;

function tokenize(command: string): Token[] | string {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) tokens.push({ sep: false, word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return "unterminated quote";
      word += command.slice(i + 1, close);
      inWord = true;
      i = close;
      continue;
    }
    if (ch === "\"") {
      let j = i + 1;
      for (; j < command.length && command[j] !== "\""; j += 1) {
        const c = command[j];
        if (c === "`") return "backticks are not allowed in Plan mode";
        if (c === "$" && command[j + 1] === "(") return "command substitution $( ) is not allowed in Plan mode";
        if (c === "\\" && command[j + 1] === "\"") return "escaped quotes are not allowed in Plan mode";
      }
      if (j >= command.length) return "unterminated quote";
      word += command.slice(i + 1, j);
      inWord = true;
      i = j;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") {
      endWord();
      tokens.push({ sep: true });
      continue;
    }
    if (ch === "|") {
      endWord();
      tokens.push({ sep: true });
      if (next === "|") i += 1;
      continue;
    }
    if (ch === "&") {
      if (next === "&") {
        endWord();
        tokens.push({ sep: true });
        i += 1;
        continue;
      }
      return "& (background job or call operator) is not allowed in Plan mode";
    }
    if (ch === ">") {
      const stream = inWord ? word : "";
      if (stream === "" || stream === "1" || stream === "2" || stream === "*") {
        const rest = command.slice(i + 1).replace(/^\s*/, "");
        const target = DISCARD_TARGET.exec(rest);
        if (target && (target[1] !== "&1" || stream === "2" || stream === "*")) {
          word = "";
          inWord = false;
          i = command.length - rest.length + target[0].length - 1;
          continue;
        }
      }
      return "output redirection is not allowed in Plan mode";
    }
    if (ch === "<") return "input redirection is not allowed in Plan mode";
    if (ch === "`") return "backticks are not allowed in Plan mode";
    if (ch === "(" || ch === ")") return "parentheses (subexpressions, subshells) are not allowed in Plan mode";
    if (ch === "{" || ch === "}") return "braces (script blocks) are not allowed in Plan mode";
    if ((ch === "$" || ch === "@") && next === "(") return "command substitution is not allowed in Plan mode";
    word += ch;
    inWord = true;
  }
  endWord();
  return tokens;
}

function commandName(word: string): string | undefined {
  if (/[\\/]/.test(word)) return undefined;
  return word.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

/**
 * Decide whether run_command may execute `command` in Plan mode.
 * @param command - the raw command string from run_command.
 */
export function checkPlanModeCommand(command: string): PlanModeCommandCheck {
  const tokens = tokenize(command);
  if (typeof tokens === "string") return { allowed: false, reason: tokens };
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token.sep) segments.push([]);
    else segments[segments.length - 1].push(token.word);
  }
  const nonEmpty = segments.filter((segment) => segment.length > 0);
  if (nonEmpty.length === 0) return { allowed: false, reason: "empty command" };
  for (const [first, ...args] of nonEmpty) {
    if (args.includes("--%")) return { allowed: false, reason: "--% is not allowed in Plan mode" };
    const name = commandName(first);
    if (name === undefined) return { allowed: false, reason: `${first}: run commands by name, not by path, in Plan mode` };
    const rule = COMMANDS[name];
    if (!rule) return { allowed: false, reason: `${first} is not on the Plan mode allowlist` };
    const reason = rule(args);
    if (reason) return { allowed: false, reason };
  }
  return { allowed: true };
}

/** Exposed for tests: whether a bare command name is allowlisted. */
export function isPlanModeCommandName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name.toLowerCase());
}
