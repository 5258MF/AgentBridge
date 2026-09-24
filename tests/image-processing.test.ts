import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as photon from "@silvia-odwyer/photon-node";
import {
  base64Length,
  IMAGE_MAX_BASE64_BYTES,
  IMAGE_MAX_EDGE,
  IMAGE_MAX_PIXELS,
  preflightImage,
  prepareImage,
  readImageHeader,
  sniffImageFormat,
} from "../src/extension/src/image-processing.js";
import { formatReadImageFileForModel, readImageFile } from "../src/extension/src/read-files.js";

type Pixel = [number, number, number, number];

function rgba(width: number, height: number, pixel: (x: number, y: number) => Pixel): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set(pixel(x, y), (y * width + x) * 4);
  }
  return out;
}

function encode(raw: Uint8Array, width: number, height: number, kind: "png" | "jpeg" | "webp"): Buffer {
  const img = new photon.PhotonImage(raw, width, height);
  try {
    if (kind === "png") return Buffer.from(img.get_bytes());
    if (kind === "jpeg") return Buffer.from(img.get_bytes_jpeg(95));
    return Buffer.from(img.get_bytes_webp());
  } finally {
    img.free();
  }
}

function gradient(width: number, height: number): Uint8Array {
  return rgba(width, height, (x, y) => [(x * 255 / width) | 0, (y * 255 / height) | 0, 128, 255]);
}

/** Deterministic noise: incompressible, so PNG output is large. */
function noise(width: number, height: number): Uint8Array {
  let seed = 12345;
  const next = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  return rgba(width, height, () => [next(), next(), next(), 255]);
}

/** Uncompressed 24-bit bottom-up BMP. */
function bmp(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write("BM", 0, "latin1");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      buf[row + x * 3] = b;
      buf[row + x * 3 + 1] = g;
      buf[row + x * 3 + 2] = r;
    }
  }
  return buf;
}

/** Inserts an EXIF APP1 segment with the given orientation right after SOI. */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

function decode(data: Buffer): { width: number; height: number; pixel: (x: number, y: number) => Pixel } {
  const img = photon.PhotonImage.new_from_byteslice(data);
  const width = img.get_width();
  const height = img.get_height();
  const raw = img.get_raw_pixels();
  img.free();
  return { width, height, pixel: (x, y) => Array.from(raw.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)) as Pixel };
}

const loadPhoton = () => photon;

test("formats are sniffed from bytes and headers give dimensions without decoding", () => {
  const png = encode(gradient(30, 20), 30, 20, "png");
  const jpeg = encode(gradient(30, 20), 30, 20, "jpeg");
  const webp = encode(gradient(30, 20), 30, 20, "webp");
  const bitmap = bmp(30, 20, () => [1, 2, 3]);
  const gif = Buffer.from([...Buffer.from("GIF89a", "latin1"), 30, 0, 20, 0, 0, 0, 0]);
  for (const [buf, format] of [[png, "png"], [jpeg, "jpeg"], [webp, "webp"], [bitmap, "bmp"], [gif, "gif"]] as const) {
    assert.equal(sniffImageFormat(buf), format);
    assert.deepEqual({ ...readImageHeader(buf, format), orientation: undefined }, { width: 30, height: 20, orientation: undefined }, format);
  }
  assert.equal(sniffImageFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), undefined);
  assert.equal(readImageHeader(withExifOrientation(jpeg, 6), "jpeg")?.orientation, 6);
});

test("images that already fit are sent byte-for-byte", () => {
  const png = encode(gradient(640, 480), 640, 480, "png");
  const result = prepareImage(png, () => { throw new Error("photon must not load"); });
  assert.ok(result.ok);
  assert.equal(result.image.unchanged, true);
  assert.equal(result.image.mimeType, "image/png");
  assert.ok(result.image.data.equals(png));
});

test("images above the long-edge limit are downscaled", () => {
  const png = encode(gradient(2400, 1200), 2400, 1200, "png");
  const result = prepareImage(png, loadPhoton);
  assert.ok(result.ok);
  assert.equal(result.image.unchanged, false);
  assert.equal(result.image.mimeType, "image/png");
  assert.equal(result.image.width, IMAGE_MAX_EDGE);
  assert.equal(result.image.height, IMAGE_MAX_EDGE / 2);
  assert.deepEqual([result.image.source.width, result.image.source.height], [2400, 1200]);
  const decoded = decode(result.image.data);
  assert.deepEqual([decoded.width, decoded.height], [IMAGE_MAX_EDGE, IMAGE_MAX_EDGE / 2]);
});

test("images over the base64 budget are re-encoded as JPEG within the budget", () => {
  const png = encode(noise(1900, 1900), 1900, 1900, "png");
  assert.ok(base64Length(png.length) > IMAGE_MAX_BASE64_BYTES, "fixture must exceed the budget");
  const result = prepareImage(png, loadPhoton);
  assert.ok(result.ok);
  assert.equal(result.image.mimeType, "image/jpeg");
  assert.ok(base64Length(result.image.data.length) <= IMAGE_MAX_BASE64_BYTES);
  assert.ok(result.image.notes.some((note) => note.includes("JPEG")));
});

test("BMP is converted to PNG", () => {
  const result = prepareImage(bmp(8, 4, (x) => (x < 4 ? [255, 0, 0] : [0, 0, 255])), loadPhoton);
  assert.ok(result.ok);
  assert.equal(result.image.mimeType, "image/png");
  const decoded = decode(result.image.data);
  assert.deepEqual(decoded.pixel(0, 0).slice(0, 3), [255, 0, 0]);
  assert.deepEqual(decoded.pixel(7, 3).slice(0, 3), [0, 0, 255]);
});

test("JPEG EXIF orientation is applied and dimensions are swapped", () => {
  // Red top-left quadrant; orientation 6 means "rotate 90° clockwise to display".
  const raw = rgba(300, 200, (x, y) => (x < 150 && y < 100 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const jpeg = withExifOrientation(encode(raw, 300, 200, "jpeg"), 6);
  const result = prepareImage(jpeg, loadPhoton);
  assert.ok(result.ok);
  assert.deepEqual([result.image.width, result.image.height], [200, 300]);
  assert.deepEqual([result.image.source.width, result.image.source.height], [200, 300]);
  const decoded = decode(result.image.data);
  const [r, , b] = decoded.pixel(190, 10);
  assert.ok(r > 200 && b < 60, "red quadrant must move to the top-right");
  const [r2, , b2] = decoded.pixel(10, 10);
  assert.ok(r2 < 60 && b2 > 200);
});

test("pixel bombs and non-images are rejected before decoding", () => {
  const png = encode(gradient(10, 10), 10, 10, "png");
  png.writeUInt32BE(10_000, 16);
  png.writeUInt32BE(10_000, 20);
  assert.ok(10_000 * 10_000 > IMAGE_MAX_PIXELS);
  const bomb = preflightImage(png);
  assert.equal(bomb.kind, "error");
  assert.equal(bomb.kind === "error" && bomb.code, "IMAGE_TOO_LARGE");
  const text = preflightImage(Buffer.from("just text"));
  assert.equal(text.kind === "error" && text.code, "UNSUPPORTED_IMAGE_TYPE");
});

test("read_image_file trusts file bytes over the extension and reports what was sent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-image-"));
  try {
    fs.writeFileSync(path.join(root, "photo.png"), encode(gradient(40, 30), 40, 30, "jpeg"));
    const small = await readImageFile({ path: "photo.png" }, { workspaceRoots: [root] });
    assert.equal(small.status, "success");
    assert.equal(small.success?.mimeType, "image/jpeg");
    assert.equal(small.success?.unchanged, true);
    assert.match(formatReadImageFileForModel(small), /sent {4}original file unchanged/);

    fs.writeFileSync(path.join(root, "wide.png"), encode(gradient(4000, 1000), 4000, 1000, "png"));
    const wide = await readImageFile({ path: "wide.png" }, { workspaceRoots: [root] });
    assert.equal(wide.status, "success");
    const summary = formatReadImageFileForModel(wide);
    assert.match(summary, /source {2}PNG 4000×1000/);
    assert.match(summary, /sent {4}PNG 2000×500/);
    assert.match(summary, /scale {3}0\.500/);

    fs.writeFileSync(path.join(root, "notes.png"), "not an image");
    const bad = await readImageFile({ path: "notes.png" }, { workspaceRoots: [root] });
    assert.equal(bad.error?.code, "UNSUPPORTED_IMAGE_TYPE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
