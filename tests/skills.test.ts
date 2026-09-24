import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeManager } from "../src/extension/src/bridge-server.js";
import { BRIDGE_TOOL_DEFINITIONS, READ_ONLY_BLOCKED_TOOL_NAMES } from "../src/extension/src/server-instructions.js";
import {
  discoverSkills,
  formatSkillCatalog,
  LOAD_SKILL_TOOL,
  loadSkill,
  MAX_SKILL_DESCRIPTION_LENGTH,
  parseLoadSkillInput,
  parseSkillFrontmatter,
  renderLoadSkillDescription,
  SKILL_CATALOG_PLACEHOLDER,
} from "../src/extension/src/skills.js";
import { vscodeTest, workspace } from "./helpers/fake-vscode.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-skills-"));
}

function writeSkill(root: string, folder: string, frontmatter: string, body = "Do the thing.", extra: Record<string, string | Buffer> = {}): string {
  const dir = path.join(root, ".agents", "skills", folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  for (const [name, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: any) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test("frontmatter: plain, quoted, block, folded, continued, and nested values", () => {
  const parsed = parseSkillFrontmatter([
    "\uFEFF---",
    "name: pdf-tools",
    "description: >",
    "  Extract text and tables",
    "  from PDF files.",
    "title: \"A \\\"quoted\\\" title\"",
    "single: 'it''s fine'",
    "literal: |",
    "  line one",
    "  line two",
    "plain: first part",
    "  second part",
    "metadata:",
    "  author: someone",
    "disable-model-invocation: false # comment",
    "---",
    "# Body",
  ].join("\r\n"));
  assert.ok(parsed);
  assert.equal(parsed.fields.name, "pdf-tools");
  assert.equal(parsed.fields.description, "Extract text and tables from PDF files.");
  assert.equal(parsed.fields.title, "A \"quoted\" title");
  assert.equal(parsed.fields.single, "it's fine");
  assert.equal(parsed.fields.literal, "line one\nline two");
  assert.equal(parsed.fields.plain, "first part second part");
  assert.equal(parsed.fields.metadata, undefined, "nested mappings are skipped");
  assert.equal(parsed.fields["disable-model-invocation"], "false");
  assert.equal(parsed.body, "# Body");
  assert.equal(parseSkillFrontmatter("# no frontmatter"), undefined);
  assert.equal(parseSkillFrontmatter("---\nname: x\n"), undefined, "unterminated frontmatter");
});

test("discovery: workspace roots first, then ~/.agents/skills; first name wins; invalid skills are warnings", async () => {
  const ws1 = tempDir();
  const ws2 = tempDir();
  const home = tempDir();
  writeSkill(ws1, "deploy", "name: deploy\ndescription: Deploy from workspace one.");
  writeSkill(ws2, "deploy", "name: deploy\ndescription: Deploy from workspace two.");
  writeSkill(ws2, "lint", "description: Folder name becomes the name.");
  writeSkill(home, "deploy", "name: deploy\ndescription: User deploy.");
  writeSkill(home, "notes", "name: notes\ndescription: |\n  Multi\n  line   description.");
  writeSkill(home, "hidden", "name: hidden\ndescription: Hidden skill.\ndisable-model-invocation: true");
  writeSkill(home, "nodesc", "name: nodesc");
  writeSkill(home, ".dot", "name: dot\ndescription: Hidden folder.");
  fs.mkdirSync(path.join(home, ".agents", "skills", "empty-folder"));
  fs.mkdirSync(path.join(home, ".agents", "skills", "not-a-skill", "nested", "deep"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agents", "skills", "not-a-skill", "nested", "deep", "SKILL.md"), "---\nname: nested\ndescription: Nested.\n---\n");
  fs.writeFileSync(path.join(home, ".agents", "skills", "README.md"), "a file at the root is not a skill");
  fs.mkdirSync(path.join(home, ".agents", "skills", "nofront"));
  fs.writeFileSync(path.join(home, ".agents", "skills", "nofront", "SKILL.md"), "# No frontmatter\n");
  writeSkill(home, "long", `name: long\ndescription: ${"x".repeat(MAX_SKILL_DESCRIPTION_LENGTH + 50)}`);

  const { skills, warnings } = await discoverSkills({ workspaceRoots: [ws1, ws2], homeDir: home });
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  assert.deepEqual(skills.map((skill) => skill.name), ["deploy", "lint", "hidden", "long", "notes"]);
  assert.equal(byName.get("hidden")?.onRequestOnly, true, "disable-model-invocation skills stay loadable by name");
  assert.equal(byName.get("notes")?.onRequestOnly, false);
  assert.equal(byName.get("deploy")?.description, "Deploy from workspace one.");
  assert.equal(byName.get("deploy")?.source, "workspace");
  assert.equal(byName.get("deploy")?.workspacePath, ".agents/skills/deploy/SKILL.md");
  assert.equal(byName.get("lint")?.description, "Folder name becomes the name.");
  assert.equal(byName.get("notes")?.source, "user");
  assert.equal(byName.get("notes")?.workspacePath, undefined);
  assert.equal(byName.get("notes")?.description, "Multi line description.");
  assert.equal(byName.get("long")?.description.length, MAX_SKILL_DESCRIPTION_LENGTH);
  assert.ok(warnings.some((warning) => warning.includes("already provided")), "shadowed duplicates are reported");
  assert.ok(warnings.some((warning) => warning.includes("description is required")));
  assert.ok(warnings.some((warning) => warning.includes("no YAML frontmatter")));

  const none = await discoverSkills({ workspaceRoots: [tempDir()], homeDir: undefined });
  assert.deepEqual(none, { skills: [], warnings: [] }, "missing skill folders are not an error");
});

test("catalog text and tool definition", async () => {
  assert.ok(LOAD_SKILL_TOOL.description.endsWith(SKILL_CATALOG_PLACEHOLDER));
  assert.ok(BRIDGE_TOOL_DEFINITIONS.some((tool) => tool.name === LOAD_SKILL_TOOL.name));
  assert.ok(!READ_ONLY_BLOCKED_TOOL_NAMES.has(LOAD_SKILL_TOOL.name), "load_skill is read-only and stays available in Plan mode");

  const ws = tempDir();
  writeSkill(ws, "deploy", "name: deploy\ndescription: Deploy the app.");
  const { skills } = await discoverSkills({ workspaceRoots: [ws] });
  const description = renderLoadSkillDescription(skills);
  assert.ok(!description.includes(SKILL_CATALOG_PLACEHOLDER));
  assert.match(description, /\nAvailable skills:\n- deploy: Deploy the app\.$/);

  writeSkill(ws, "grill-me", "name: grill-me\ndescription: 持续追问式访谈。\ndisable-model-invocation: true");
  const both = renderLoadSkillDescription((await discoverSkills({ workspaceRoots: [ws] })).skills);
  assert.match(both, /\nAvailable skills:\n- deploy: Deploy the app\.\n\nLoad these only when the user names them, never on your own:\n- grill-me: 持续追问式访谈。$/);
  const onlyOnRequest = formatSkillCatalog((await discoverSkills({ workspaceRoots: [ws] })).skills.filter((skill) => skill.onRequestOnly));
  assert.match(onlyOnRequest, /^Load these only when the user names them/);
  assert.match(formatSkillCatalog([]), /^No skills are installed\./);
  assert.match(LOAD_SKILL_TOOL.description, /When the user names a skill, for example \/deploy/);
});

test("load_skill: list, load by name, read a file, and errors", async () => {
  const ws = tempDir();
  const home = tempDir();
  const dir = writeSkill(ws, "deploy", "name: deploy\ndescription: Deploy the app.", "# Deploy\n\nRun scripts/deploy.ps1.", {
    "scripts/deploy.ps1": "Write-Host deploy\r\n",
    "reference.md": "\uFEFFReference text\n",
    "bin/tool.bin": Buffer.from([0, 1, 2, 3]),
    ".secret": "hidden",
  });
  writeSkill(home, "notes", "name: notes\ndescription: Notes.\ndisable-model-invocation: true");
  fs.writeFileSync(path.join(ws, "outside.txt"), "outside");
  const context = { workspaceRoots: [ws], homeDir: home };

  const listed = await loadSkill({}, context);
  assert.match(listed.text, /^skills: 2\n- deploy \(workspace\): Deploy the app\.\n  location: .+SKILL\.md\n- notes \(user, only when the user names it\): Notes\./);
  assert.match((await loadSkill({ name: "notes" }, context)).text, /^skill: notes\n/, "on-request skills load by name");

  const loaded = await loadSkill({ name: "deploy" }, context);
  assert.match(loaded.text, /^skill: deploy\nsource: workspace\ndirectory: /);
  assert.ok(loaded.text.includes(`directory: ${dir}\n`));
  assert.match(loaded.text, /files: bin\/tool\.bin, reference\.md, scripts\/deploy\.ps1\n/);
  assert.match(loaded.text, /--- CONTENT BEGIN ---\n# Deploy\n\nRun scripts\/deploy\.ps1\.\n--- CONTENT END ---$/);
  assert.ok(!loaded.text.includes("description: Deploy"), "frontmatter is not repeated");
  assert.equal((await loadSkill({ name: "DEPLOY" }, context)).structuredContent.name, "deploy", "names match case-insensitively as a fallback");

  const file = await loadSkill({ name: "deploy", file: "scripts\\deploy.ps1" }, context);
  assert.match(file.text, /^skill: deploy\nfile: scripts\/deploy\.ps1\npath: .+\n--- CONTENT BEGIN ---\nWrite-Host deploy\n--- CONTENT END ---$/);
  assert.match((await loadSkill({ name: "deploy", file: "reference.md" }, context)).text, /BEGIN ---\nReference text\n--- CONTENT/);

  await rejectsWithCode(loadSkill({ name: "missing" }, context), "SKILL_NOT_FOUND");
  await rejectsWithCode(loadSkill({ name: "deploy", file: "../../../outside.txt" }, context), "PATH_OUTSIDE_SKILL");
  await rejectsWithCode(loadSkill({ name: "deploy", file: path.join(ws, "outside.txt") }, context), "PATH_OUTSIDE_SKILL");
  await rejectsWithCode(loadSkill({ name: "deploy", file: "." }, context), "PATH_OUTSIDE_SKILL");
  await rejectsWithCode(loadSkill({ name: "deploy", file: "nope.md" }, context), "FILE_NOT_FOUND");
  await rejectsWithCode(loadSkill({ name: "deploy", file: "scripts" }, context), "NOT_A_FILE");
  await rejectsWithCode(loadSkill({ name: "deploy", file: "bin/tool.bin" }, context), "BINARY_FILE");
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(300 * 1024));
  await rejectsWithCode(loadSkill({ name: "deploy", file: "big.txt" }, context), "FILE_TOO_LARGE");

  try {
    fs.symlinkSync(path.join(ws, "outside.txt"), path.join(dir, "link.txt"));
  } catch {
    return; // Symlinks need extra rights on Windows.
  }
  await rejectsWithCode(loadSkill({ name: "deploy", file: "link.txt" }, context), "PATH_OUTSIDE_SKILL");
});

test("load_skill arguments are validated", () => {
  assert.deepEqual(parseLoadSkillInput(undefined), {});
  assert.deepEqual(parseLoadSkillInput({ name: " deploy " }), { name: "deploy", file: undefined });
  assert.throws(() => parseLoadSkillInput({ file: "a.md" }), /INVALID_ARGUMENT|file requires name/);
  assert.throws(() => parseLoadSkillInput({ name: "" }), /name must be a non-empty string/);
  assert.throws(() => parseLoadSkillInput({ name: "x", extra: 1 }), /unknown argument extra/);
});

function makeManager(): BridgeManager {
  vscodeTest.reset();
  const globalState = new Map<string, unknown>();
  const context: any = {
    extensionMode: 1,
    extension: { packageJSON: { version: "0.1.14" } },
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    globalState: {
      get: <T>(key: string, fallback?: T) => (globalState.has(key) ? globalState.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
  };
  const output = { append() {}, appendLine() {} } as any;
  const broker = { invokeDirect: async () => ({ text: "", isError: false }), dispose() {} } as any;
  return new BridgeManager(context, output, broker);
}

test("tools/list fills the skill catalog; load_skill calls go through the bridge and work in Plan mode", async () => {
  const ws = tempDir();
  const home = tempDir();
  writeSkill(ws, "deploy", "name: deploy\ndescription: Deploy the app.");
  const originalFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
  try {
    const manager = makeManager();
    (manager as any).agentsHomeDir = home;

    const tools = await (manager as any).listToolsForClient() as Array<{ name: string; description: string }>;
    assert.deepEqual(tools.map((tool) => tool.name), BRIDGE_TOOL_DEFINITIONS.map((tool) => tool.name));
    const loadSkillTool = tools.find((tool) => tool.name === "load_skill");
    assert.match(loadSkillTool!.description, /Available skills:\n- deploy: Deploy the app\.$/);
    assert.ok(tools.every((tool) => !tool.description.includes("${RUNTIME_")), "every placeholder is filled");

    writeSkill(home, "notes", "name: notes\ndescription: Notes added later.");
    const again = await (manager as any).listToolsForClient() as Array<{ name: string; description: string }>;
    assert.match(again.find((tool) => tool.name === "load_skill")!.description, /- notes: Notes added later\./, "rescanned on every tools/list");

    manager.setReadOnlyMode(true);
    const result = await (manager as any).executeToolCall("load_skill", { name: "deploy" }, {});
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /^skill: deploy\n/);
    const activity = manager.getStatus().activities.find((item) => item.tool === "load_skill");
    assert.equal(activity?.status, "completed");
    assert.equal(activity?.presentation?.title, "Loaded skill deploy");
    assert.deepEqual(activity?.presentation?.files, [".agents/skills/deploy/SKILL.md"], "workspace skills can be opened from the panel");

    const missing = await (manager as any).executeToolCall("load_skill", { name: "nope" }, {});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /^SKILL_NOT_FOUND: No skill named nope\.\nHint: Available skills: deploy, notes\./);
  } finally {
    workspace.workspaceFolders = originalFolders;
  }
});
