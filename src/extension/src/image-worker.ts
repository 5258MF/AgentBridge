// Worker-thread entry for read_image_file image preparation. Bundled separately as
// dist/image-worker.js next to photon_rs_bg.wasm (see build.mjs). One worker handles
// one image and then exits, which also releases the WebAssembly memory.
import { parentPort, workerData } from "node:worker_threads";
import * as photon from "@silvia-odwyer/photon-node";
import { prepareImage } from "./image-processing.js";

const input = workerData as { data: Uint8Array };
parentPort?.postMessage(prepareImage(input.data, () => photon));
