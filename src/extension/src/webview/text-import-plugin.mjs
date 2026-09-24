// esbuild plugin: `import text from "webview:panel.js"` inlines the file from this directory as a
// string. The panel's script and styles live in real .js/.css files (editor support, no template
// literal escaping) and are embedded into the webview HTML by bridge-panel.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webviewDir = path.dirname(fileURLToPath(import.meta.url));

export const webviewTextPlugin = {
  name: "agentbridge-webview-text",
  setup(build) {
    build.onResolve({ filter: /^webview:/ }, (args) => ({
      path: path.join(webviewDir, args.path.slice("webview:".length)),
      namespace: "agentbridge-webview-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "agentbridge-webview-text" }, (args) => ({
      contents: fs.readFileSync(args.path, "utf8"),
      loader: "text",
      watchFiles: [args.path],
    }));
  },
};

/** Path of a file in this directory, for build-time checks. */
export function webviewAssetPath(name) {
  return path.join(webviewDir, name);
}
