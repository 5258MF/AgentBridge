// AgentBridge build script: produces CJS bundles for VS Code.
//   dist/extension.js          AgentBridge extension (external vscode)
//   dist/image-worker.js       read_image_file decode/resize worker (Photon)
//   dist/photon_rs_bg.wasm     Photon WebAssembly module, loaded by the worker
//                              from its own directory (__dirname)
// Windows loads the bundled rg.exe from runtime/bin/. Other platforms use a
// PATH-resolved rg when available and otherwise use the built-in Node fallback.
import { build, context, transformSync } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { webviewAssetPath, webviewTextPlugin } from "./src/extension/src/webview/text-import-plugin.mjs";

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

const require = createRequire(import.meta.url);
const photonDir = path.dirname(require.resolve("@silvia-odwyer/photon-node/package.json"));

// Photon's CJS entry reads photon_rs_bg.wasm from __dirname, which is dist/ once
// bundled. Without this copy every image that needs resizing would fail at runtime.
function copyPhotonAssets() {
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.copyFileSync(path.join(photonDir, "photon_rs_bg.wasm"), path.join(distDir, "photon_rs_bg.wasm"));
  fs.copyFileSync(path.join(photonDir, "LICENSE.md"), path.join(distDir, "photon-node-LICENSE.md"));
}

const config = {
  entryPoints: [path.join(root, "src/extension/src/extension.ts")],
  outfile: path.join(root, "dist/extension.js"),
  // Photon is only loaded by dist/image-worker.js; keep it out of the extension bundle.
  external: ["vscode", "@silvia-odwyer/photon-node"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  plugins: [packagedRipgrepPlugin, webviewTextPlugin],
};

const workerConfig = {
  entryPoints: [path.join(root, "src/extension/src/image-worker.ts")],
  outfile: path.join(root, "dist/image-worker.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
};

copyPhotonAssets();

if (watch) {
  const ctx = await context(config);
  const workerCtx = await context(workerConfig);
  await Promise.all([ctx.watch(), workerCtx.watch()]);
  console.log("[build] watching for changes...");
} else {
  await build(config);
  await build(workerConfig);
  // The panel script is inlined as text (webviewTextPlugin), so esbuild never parses it.
  // Check its syntax here instead of finding out in the webview.
  transformSync(fs.readFileSync(webviewAssetPath("panel.js"), "utf8"), { loader: "js" });
  const bundle = fs.readFileSync(config.outfile, "utf8");
  if (bundle.includes("photon_rs_bg.wasm")) {
    throw new Error("[build] Photon must not be bundled into dist/extension.js");
  }
  console.log("[build] done: dist/extension.js (webview script syntax OK), dist/image-worker.js, dist/photon_rs_bg.wasm");
}
