import { build } from "esbuild";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
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
const requirePackage = args.includes("--require-package");
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
  // Excluded here as well as in .vscodeignore: relying on the ignore file alone means a
  // change to that one file silently ships scratch data inside the validation copy.
  if ([".git", "node_modules", "dist", ".vscode-test", ".vscode-test-web", ".workbuddy"].includes(first)) return false;
  const basename = path.basename(normalized).toLowerCase();
  if (basename.endsWith(".vsix") || basename.endsWith(".orig") || basename.endsWith(".log")) return false;
  if (basename === "tsconfig.tsbuildinfo") return false;
  if (/^_.*\.cjs$/i.test(basename) || /^build-args-.*\.txt$/i.test(basename)) return false;
  return true;
}

try {
  console.log("[test] TypeScript checking test sources...");
  run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join("tests", "tsconfig.json"), "--noEmit"]);

  // Discovered, not listed: a hard-coded array silently stops running any file that is not
  // added to it, which reads as passing while covering nothing.
  const allEntries = (await readdir(testsDir)).filter((name) => name.endsWith(".test.ts")).sort();
  const entries = match ? allEntries.filter((name) => name.replace(/\.test\.ts$/, "") === match) : allEntries;
  if (!entries.length) throw new Error(`No test entry matched ${JSON.stringify(match)}.`);
  const fakeVscode = path.join(testsDir, "helpers", "fake-vscode.ts");
  const fakeChildProcess = path.join(testsDir, "helpers", "fake-child-process.ts");
  const fakeHttp = path.join(testsDir, "helpers", "fake-http.ts");
  const fakeHttps = path.join(testsDir, "helpers", "fake-https.ts");
  const moduleReplacement = {
    name: "agentbridge-test-module-replacement",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: fakeVscode }));
      buildApi.onResolve({ filter: /^node:child_process$/ }, () => ({ path: fakeChildProcess }));
      buildApi.onResolve({ filter: /^node:http$/ }, () => ({ path: fakeHttp }));
      buildApi.onResolve({ filter: /^node:https$/ }, () => ({ path: fakeHttps }));
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
    // The real-shell tests are on by default: they skip themselves per shell, so a machine
    // without the shell simply covers less, and leaving them off hid the only coverage that
    // settles a script's fate against an actual readline. Set it to 0 to turn them off.
    env: {
      ...process.env,
      NODE_PATH: path.join(root, "node_modules"),
      AGENTBRIDGE_PTY_INTEGRATION: process.env.AGENTBRIDGE_PTY_INTEGRATION ?? "1",
    },
  });

  if (!skipPackage) {
    if (process.platform !== "win32") {
      if (requirePackage) throw new Error("完整 Windows 发布包验收不支持当前平台。");
      console.log("[test] Skipping Windows packaging validation: unsupported platform (pass --require-package to fail instead).");
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
        // pwsh is not installed everywhere; Windows PowerShell 5.1 can read the same archive.
        let listed = spawnSync("pwsh", ["-NoProfile", "-Command", ps], { cwd: packageWorkspace, encoding: "utf8" });
        if (listed.error) {
          listed = spawnSync("powershell", ["-NoProfile", "-Command", ps], { cwd: packageWorkspace, encoding: "utf8" });
        }
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
          "vendor/PSReadLine/PSReadLine.psd1",
          "package.nls.json",
          "package.nls.zh-cn.json",
          "README.md",
          "README.zh-CN.md",
          "CHANGELOG.md",
          // The package carries vendor/PSReadLine (BSD-2-Clause) and runtime/bin/rg.exe, and
          // this is the only file holding the BSD text. Nothing imports it, so losing it to a
          // careless .vscodeignore line would leave every test green and the notice unshipped.
          "THIRD_PARTY_NOTICES.md",
        ].map((value) => `${prefix}${value}`);
        const lowerEntries = new Set(entriesInVsix.map((value) => value.toLowerCase()));
        for (const requiredEntry of required) {
          if (!lowerEntries.has(requiredEntry.toLowerCase())) throw new Error(`VSIX missing required entry: ${requiredEntry}`);
        }
        // The licence is looked for by shape and not by name because vsce renames a top-level
        // LICENSE to LICENSE.txt on the way in, so the name in the archive is not the name in
        // the repository. It is worth looking for at all for the same reason as the notices
        // above: nothing imports it, so a package without one still reported success.
        const licence = entriesInVsix
          .map((value) => value.slice(prefix.length))
          .find((value) => /^license(\.(md|txt))?$/i.test(value));
        if (!licence) throw new Error(`VSIX does not ship a LICENSE file (entries: ${entriesInVsix.join(", ")})`);
        const forbidden = entriesInVsix.filter((value) => {
          const lower = value.toLowerCase();
          return lower.includes("/tests/")
            || lower.startsWith("tests/")
            || lower.includes("test-build")
            || lower.includes("mutation")
            || lower.includes("workbuddy")
            || lower.endsWith(".map")
            || lower.endsWith("tsconfig.test.json");
        });
        if (forbidden.length) throw new Error(`VSIX contains forbidden test artifacts:\n${forbidden.join("\n")}`);
        if (entriesInVsix.length > 60) {
          throw new Error(`VSIX has ${entriesInVsix.length} entries, expected at most 60: ${entriesInVsix.join("\n")}`);
        }
        console.log(`[test] VSIX isolation OK (${entriesInVsix.length} ZIP entries, prefix ${JSON.stringify(prefix)}).`);
      } finally {
        await rm(packageDir, { recursive: true, force: true });
      }
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
