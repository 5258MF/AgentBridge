// "webview:<file>" imports resolve to the text of src/extension/src/webview/<file>, inlined at
// build time by text-import-plugin.mjs (used by build.mjs and tests/run-tests.mjs).
declare module "webview:*" {
  const text: string;
  export default text;
}
