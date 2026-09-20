import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFiles } from "../src/extension/src/find-files.js";
import { gitignoreIgnores, globalIgnoreRules, type IgnoreEnvironment } from "../src/extension/src/gitignore.js";

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function listedFrom(root: string, entries: Array<{ path: string }>): string[] {
  return entries
    .map((entry) => path.relative(root, path.isAbsolute(entry.path) ? entry.path : path.join(root, entry.path)).split(path.sep).join("/"))
    .sort();
}

test("the global exclude is read from the default location under the config home", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-global-ignore-")));
  try {
    writeFile(path.join(tmp, ".config", "git", "ignore"), "# comment\nglobal-probe.txt\n");
    const env: IgnoreEnvironment = { HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, ".config") };
    const rules = await globalIgnoreRules(env);
    assert.equal(gitignoreIgnores("global-probe.txt", rules), true);
    assert.equal(gitignoreIgnores("keep.txt", rules), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the global exclude is read once per process, not once per call", async () => {
  // Every find_files and search_files call read the per-user git config and then the file it
  // names, from the beginning. They are the user's configuration rather than the repository's,
  // so reading them once is enough: a change is picked up when the window is reloaded, which is
  // how the rest of the configuration behaves. The rules above the walk root are still read
  // every time, because those files belong to directories that can change underneath us.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-global-once-")));
  try {
    const env: IgnoreEnvironment = { HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, ".config") };
    writeFile(path.join(tmp, ".config", "git", "ignore"), "first-probe.txt\n");
    const first = await globalIgnoreRules(env);
    assert.equal(gitignoreIgnores("first-probe.txt", first), true);

    writeFile(path.join(tmp, ".config", "git", "ignore"), "second-probe.txt\n");
    const second = await globalIgnoreRules(env);
    assert.equal(gitignoreIgnores("first-probe.txt", second), true, "the file is not read again");
    assert.equal(gitignoreIgnores("second-probe.txt", second), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("core.excludesFile names the global exclude, and its ~ is the home directory", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-excludes-file-")));
  try {
    writeFile(path.join(tmp, ".gitconfig"), "[user]\n\tname = nobody\n[core]\n\texcludesFile = ~/custom-ignore\n");
    writeFile(path.join(tmp, "custom-ignore"), "custom-probe.txt\n");
    // No default file at all: the value in the config is the only source here.
    const rules = await globalIgnoreRules({ HOME: tmp });
    assert.equal(gitignoreIgnores("custom-probe.txt", rules), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("GIT_CONFIG_GLOBAL replaces the per-user config files rather than joining them", async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-config-global-")));
  try {
    writeFile(path.join(tmp, "home", ".gitconfig"), "[core]\n\texcludesFile = ~/from-home\n");
    writeFile(path.join(tmp, "home", "from-home"), "home-probe.txt\n");
    writeFile(path.join(tmp, "elsewhere.gitconfig"), "[core]\n\texcludesFile = " + path.join(tmp, "from-elsewhere").replace(/\\/g, "/") + "\n");
    writeFile(path.join(tmp, "from-elsewhere"), "elsewhere-probe.txt\n");

    const rules = await globalIgnoreRules({
      HOME: path.join(tmp, "home"),
      GIT_CONFIG_GLOBAL: path.join(tmp, "elsewhere.gitconfig"),
    });
    assert.equal(gitignoreIgnores("elsewhere-probe.txt", rules), true);
    assert.equal(gitignoreIgnores("home-probe.txt", rules), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("find_files hides what the global exclude hides", async () => {
  // ripgrep applies the global exclude in every directory, inside a repository or not, so a
  // machine that has one answered differently from the same tree without it.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-global-e2e-")));
  const scope = path.join(tmp, "tree");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  try {
    writeFile(path.join(tmp, ".config", "git", "ignore"), "global-rules-probe.txt\n");
    writeFile(path.join(scope, "global-rules-probe.txt"), "needle\n");
    writeFile(path.join(scope, "keep.txt"), "needle\n");
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.XDG_CONFIG_HOME = path.join(tmp, ".config");
    delete process.env.GIT_CONFIG_GLOBAL;

    const result = await findFiles(
      { patterns: ["**/*.txt"], path: scope },
      { workspaceRoots: [scope], checkPermission: () => true },
    );
    assert.equal(result.engine, "node", JSON.stringify(result));
    assert.deepEqual(listedFrom(scope, result.files), ["keep.txt"], JSON.stringify(result.files));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
