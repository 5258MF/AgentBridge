// Runs read_image_file image preparation. Images that can be sent unchanged never
// leave the extension host; anything that must be decoded is handled by a
// short-lived worker thread so large decodes do not block VS Code.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { preflightImage, prepareImage, type ImagePrepareResult, type PreparedImage } from "./image-processing.js";

export const IMAGE_WORKER_FILE = "image-worker.js";
export const IMAGE_WORKER_TIMEOUT_MS = 60_000;

export async function prepareImageForModel(data: Buffer, signal?: AbortSignal): Promise<ImagePrepareResult> {
  const pre = preflightImage(data);
  if (pre.kind === "error") return { ok: false, code: pre.code, message: pre.message };
  if (pre.kind === "unchanged") return { ok: true, image: pre.image };

  // __dirname is dist/ in the packaged extension. Test bundles have no worker file
  // and fall back to in-process preparation with photon from node_modules.
  const workerPath = path.join(__dirname, IMAGE_WORKER_FILE);
  if (!fs.existsSync(workerPath)) return prepareInProcess(data);
  return runWorker(workerPath, data, signal);
}

function prepareInProcess(data: Buffer): ImagePrepareResult {
  return prepareImage(data, () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require("@silvia-odwyer/photon-node");
    } catch {
      throw new Error(`image processing component is missing (${IMAGE_WORKER_FILE} not found); reinstall the extension.`);
    }
  });
}

function runWorker(workerPath: string, data: Buffer, signal?: AbortSignal): Promise<ImagePrepareResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, code: "IMAGE_PROCESSING_FAILED", message: "Operation aborted." });
      return;
    }
    let settled = false;
    const worker = new Worker(workerPath, { workerData: { data } });
    const finish = (result: ImagePrepareResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(result);
    };
    const fail = (message: string) => finish({ ok: false, code: "IMAGE_PROCESSING_FAILED", message });
    const onAbort = () => fail("Operation aborted.");
    const timer = setTimeout(() => fail(`Image processing timed out after ${IMAGE_WORKER_TIMEOUT_MS / 1000}s.`), IMAGE_WORKER_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: ImagePrepareResult) => {
      if (message.ok) {
        const raw = message.image.data as unknown as Uint8Array;
        const image: PreparedImage = { ...message.image, data: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) };
        finish({ ok: true, image });
      } else {
        finish(message);
      }
    });
    worker.once("error", (err) => fail(`Image processing failed: ${err instanceof Error ? err.message : String(err)}`));
    worker.once("exit", (code) => fail(`Image worker exited unexpectedly (code ${code}).`));
  });
}
