import { build } from "esbuild";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testsDir);
const args = process.argv.slice(2);
const matchIndex = args.indexOf("--match");
const match = matchIndex >= 0 ? args[matchIndex + 1] : undefined;
const skipPackage = args.includes("--skip-package");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbridge-tests-"));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with code ${String(result.status)}.`);
}

function runCaptured(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", shell: false, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with code ${String(result.status)}.`);
  return result;
}

function shouldCopyForPackageValidation(source) {
  const relative = path.relative(root, source);
  if (!relative) return true;
  const normalized = relative.replace(/\\/g, "/");
  const first = normalized.split("/")[0];
  if ([".git", "node_modules", "dist", ".vscode-test", ".vscode-test-web"].includes(first)) return false;
  const basename = path.basename(normalized).toLowerCase();
  if (basename.endsWith(".vsix") || basename.endsWith(".orig") || basename.endsWith(".log")) return false;
  if (basename === "tsconfig.tsbuildinfo") return false;
  if (/^_.*\.cjs$/i.test(basename) || /^build-args-.*\.txt$/i.test(basename)) return false;
  return true;
}

try {
  console.log("[test] TypeScript checking test sources...");
  run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join("tests", "tsconfig.json"), "--noEmit"]);

  const allEntries = ["origin.test.ts", "trusted-origins-panel.test.ts", "bridge-start-command.test.ts", "tunnel-lifecycle.test.ts"];
  const entries = match ? allEntries.filter((name) => name.replace(/\.test\.ts$/, "") === match) : allEntries;
  if (!entries.length) throw new Error(`No test entry matched ${JSON.stringify(match)}.`);
  const fakeVscode = path.join(testsDir, "helpers", "fake-vscode.ts");
  const fakeChildProcess = path.join(testsDir, "helpers", "fake-child-process.ts");
  const fakeHttp = path.join(testsDir, "helpers", "fake-http.ts");
  const moduleReplacement = {
    name: "agentbridge-test-module-replacement",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: fakeVscode }));
      buildApi.onResolve({ filter: /^node:child_process$/ }, () => ({ path: fakeChildProcess }));
      buildApi.onResolve({ filter: /^node:http$/ }, () => ({ path: fakeHttp }));
    },
  };

  console.log(`[test] Bundling ${entries.length} test entr${entries.length === 1 ? "y" : "ies"} into ${tempDir}...`);
  await build({
    entryPoints: entries.map((entry) => path.join(testsDir, entry)),
    outdir: tempDir,
    entryNames: "[name]",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    packages: "external",
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    logLevel: "warning",
    plugins: [moduleReplacement],
  });

  const bundles = entries.map((entry) => path.join(tempDir, entry.replace(/\.ts$/, ".cjs")));
  run(process.execPath, ["--test", ...bundles], {
    env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
  });

  if (!skipPackage) {
    if (process.platform !== "win32") {
      throw new Error("完整 Windows 发布包验收不支持当前平台；如只运行核心回归测试，请显式传入 --skip-package。");
    } else {
      const packageDir = await mkdtemp(path.join(os.tmpdir(), "agentbridge-vsix-test-"));
      try {
        const packageWorkspace = path.join(packageDir, "workspace");
        const vsix = path.join(packageDir, "agentbridge-package-validation.vsix");
        console.log(`[test] Copying current workspace into ${packageWorkspace}...`);
        await cp(root, packageWorkspace, {
          recursive: true,
          filter: shouldCopyForPackageValidation,
        });
        await symlink(path.join(root, "node_modules"), path.join(packageWorkspace, "node_modules"), "junction");
        console.log("[test] Building production bundle inside temporary workspace...");
        run(process.execPath, [path.join(packageWorkspace, "build.mjs")], {
          cwd: packageWorkspace,
          env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
        });
        console.log(`[test] Packaging temporary VSIX: ${vsix}`);
        // Capture stdout instead of inheriting the AgentBridge PTY. vsce only performs its
        // optional "latest version" npm lookup when stdout is a TTY; package validation must
        // depend solely on the pinned local devDependency and the freshly built temporary copy.
        runCaptured(process.execPath, [path.join(root, "node_modules", "@vscode", "vsce", "vsce"), "package", "--out", vsix, "--no-dependencies"], {
          cwd: packageWorkspace,
          env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
        });
        const ps = [
          "Add-Type -AssemblyName System.IO.Compression.FileSystem",
          `$zip=[System.IO.Compression.ZipFile]::OpenRead('${vsix.replace(/'/g, "''")}')`,
          "try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }",
        ].join("; ");
        const listed = spawnSync("pwsh", ["-NoProfile", "-Command", ps], { cwd: packageWorkspace, encoding: "utf8" });
        if (listed.error) throw listed.error;
        if (listed.status !== 0) throw new Error(`VSIX ZIP inspection failed with code ${String(listed.status)}: ${listed.stderr}`);
        const entriesInVsix = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        const packageJsonEntry = entriesInVsix.find((value) => /(^|\/)package\.json$/i.test(value));
        if (!packageJsonEntry) throw new Error("VSIX does not contain package.json.");
        const prefix = packageJsonEntry.slice(0, -"package.json".length);
        const required = [
          "package.json",
          "dist/extension.js",
          "media/icon.png",
          "media/agentbridge.svg",
          "runtime/bin/rg.exe",
          "package.nls.json",
          "package.nls.zh-cn.json",
          "README.md",
          "README.zh-CN.md",
          "CHANGELOG.md",
        ].map((value) => `${prefix}${value}`);
        const lowerEntries = new Set(entriesInVsix.map((value) => value.toLowerCase()));
        for (const requiredEntry of required) {
          if (!lowerEntries.has(requiredEntry.toLowerCase())) throw new Error(`VSIX missing required entry: ${requiredEntry}`);
        }
        const forbidden = entriesInVsix.filter((value) => {
          const lower = value.toLowerCase();
          return lower.includes("/tests/")
            || lower.startsWith("tests/")
            || lower.includes("test-build")
            || lower.includes("mutation")
            || lower.endsWith("tsconfig.test.json");
        });
        if (forbidden.length) throw new Error(`VSIX contains forbidden test artifacts:\n${forbidden.join("\n")}`);
        console.log(`[test] VSIX isolation OK (${entriesInVsix.length} ZIP entries, prefix ${JSON.stringify(prefix)}).`);
      } finally {
        await rm(packageDir, { recursive: true, force: true });
      }
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
