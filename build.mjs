// AgentBridge build script: produces a single CJS bundle for VS Code.
//   dist/extension.js   AgentBridge extension (external vscode)
// Windows loads the bundled rg.exe from runtime/bin/. Other platforms use a
// PATH-resolved rg when available and otherwise use the built-in Node fallback.
import { build, context, transformSync } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Replace @vscode/ripgrep with the bundled Windows binary path. A Windows PE
// binary must never be offered as a candidate on macOS/Linux.
// The extension bundle lives in dist/extension.js, so __dirname = <root>/dist.
// rg.exe is at <root>/runtime/bin/rg.exe → path.join(__dirname, "..", "runtime", "bin", "rg.exe").
const packagedRipgrepPlugin = {
  name: "agentbridge-packaged-ripgrep-bin",
  setup(target) {
    target.onResolve({ filter: /^@vscode\/ripgrep$/ }, () => ({
      path: "agentbridge-packaged-ripgrep-bin",
      namespace: "agentbridge-packaged-ripgrep-bin",
    }));
    target.onLoad({ filter: /.*/, namespace: "agentbridge-packaged-ripgrep-bin" }, () => ({
      contents: 'export const rgPath = process.platform === "win32" ? require("node:path").join(__dirname, "..", "runtime", "bin", "rg.exe") : "";',
      loader: "js",
    }));
  },
};

const config = {
  entryPoints: [path.join(root, "src/extension/src/extension.ts")],
  outfile: path.join(root, "dist/extension.js"),
  external: ["vscode"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  plugins: [packagedRipgrepPlugin],
};

if (watch) {
  const ctx = await context(config);
  await ctx.watch();
  console.log("[build] watching for changes...");
} else {
  await build(config);
  // Regression check: the webview script is embedded in the HTML template string.
  // esbuild evaluates escapes like \n inside the template, which can split string
  // literals in the emitted script. Verify the extracted <script> body compiles.
  const bundle = fs.readFileSync(config.outfile, "utf8");
  const open = bundle.indexOf("<script>", bundle.indexOf("agentbridge-tabs"));
  const close = bundle.indexOf("</script>", open);
  if (open < 0 || close < 0) {
    throw new Error("[build] webview <script> not found in bundle");
  }
  const webviewScript = bundle.slice(open + 8, close);
  transformSync(webviewScript, { loader: "js" });
  console.log("[build] done: dist/extension.js (webview script syntax OK)");
}
