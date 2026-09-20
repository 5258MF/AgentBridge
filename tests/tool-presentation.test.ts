import test from "node:test";
import assert from "node:assert/strict";
import { bridgePresentation } from "../src/extension/src/bridge-server.js";

test("a read image that worked says what it was", () => {
  // The tool answers flat - status, path and the image fields side by side, the way every other
  // file tool does. The panel looked for them under a nested "success", which is not there, so an
  // image that was read fine showed no subtitle at all.
  const presentation = bridgePresentation("read_image_file", { path: "media/icon.png" }, "", {
    status: "success",
    path: "media/icon.png",
    mimeType: "image/png",
    sizeBytes: 4096,
  });
  assert.equal(presentation.subtitle, "image/png · 4.0 KB");
  assert.deepEqual(presentation.files, ["media/icon.png"]);
});

test("a read image that failed says why, not what it would have been", () => {
  const presentation = bridgePresentation("read_image_file", { path: "media/icon.png" }, "no such file", {
    status: "error",
    path: "media/icon.png",
    error: { code: "FILE_NOT_FOUND" },
  }, true);
  assert.equal(presentation.subtitle, "Image read failed · FILE_NOT_FOUND");
});
