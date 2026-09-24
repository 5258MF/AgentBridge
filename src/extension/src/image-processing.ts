// Image preparation for read_image_file.
//
// Everything in this module except the Photon-backed encoder is pure TypeScript
// and runs in the extension host: format sniffing, header dimension parsing, EXIF
// orientation lookup and the "send the original bytes" fast path. Decoding,
// resizing and re-encoding use @silvia-odwyer/photon-node (WebAssembly). In the
// packaged extension that work runs in a short-lived worker thread
// (dist/image-worker.js) so a large decode never blocks the extension host and the
// WebAssembly memory is released when the worker exits.

import type * as PhotonModule from "@silvia-odwyer/photon-node";

export type SniffedImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp";

export const IMAGE_MIME_BY_FORMAT: Readonly<Record<SniffedImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** Formats that vision model APIs accept directly and that may be sent unchanged. */
const PASSTHROUGH_FORMATS: ReadonlySet<SniffedImageFormat> = new Set(["png", "jpeg", "webp"]);
/** Sources that are usually screenshots or line art; PNG keeps text crisp. */
const PNG_PREFERRED_FORMATS: ReadonlySet<SniffedImageFormat> = new Set(["png", "gif", "bmp"]);

/** Longest edge sent to the model, in pixels. */
export const IMAGE_MAX_EDGE = 2000;
/** Largest base64 payload sent to the model (headroom below Anthropic's 5 MB per-image limit). */
export const IMAGE_MAX_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);
/** Largest source image that will be decoded (width × height). */
export const IMAGE_MAX_PIXELS = 64_000_000;
export const IMAGE_JPEG_QUALITIES: readonly number[] = [80, 70, 60, 50];
/** Each extra shrink step multiplies the long edge by this factor. */
const SHRINK_FACTOR = 0.75;
/** Give up shrinking below this long edge; the image would no longer be useful. */
const MIN_EDGE = 256;

export interface ImageHeaderInfo {
  width: number;
  height: number;
  /** EXIF orientation 1-8 (JPEG only). 1 or undefined means no transform. */
  orientation?: number;
}

export interface PreparedImageSource {
  format: SniffedImageFormat;
  mimeType: string;
  /** Dimensions as displayed (after EXIF orientation). */
  width: number;
  height: number;
  bytes: number;
}

export interface PreparedImage {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  /** True when the original file bytes are sent unchanged. */
  unchanged: boolean;
  source: PreparedImageSource;
  notes: string[];
}

export type ImagePrepareErrorCode =
  | "UNSUPPORTED_IMAGE_TYPE"
  | "IMAGE_DECODE_FAILED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_PROCESSING_FAILED";

export type ImagePrepareResult =
  | { ok: true; image: PreparedImage }
  | { ok: false; code: ImagePrepareErrorCode; message: string };

export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

export function formatByteSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Format sniffing and header parsing
// ---------------------------------------------------------------------------

export function sniffImageFormat(buf: Uint8Array): SniffedImageFormat | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && ascii(buf, 0, 6) === "GIF87a") return "gif";
  if (buf.length >= 6 && ascii(buf, 0, 6) === "GIF89a") return "gif";
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return "webp";
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  return undefined;
}

function ascii(buf: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length && i < buf.length; i++) out += String.fromCharCode(buf[i]);
  return out;
}

function u16be(b: Uint8Array, o: number): number { return (b[o] << 8) | b[o + 1]; }
function u16le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u24le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }
function u32be(b: Uint8Array, o: number): number { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
function i32le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); }

/** Reads width/height (and JPEG EXIF orientation) from the header without decoding pixels. */
export function readImageHeader(buf: Uint8Array, format: SniffedImageFormat): ImageHeaderInfo | undefined {
  const info = readRawHeader(buf, format);
  if (!info || !(info.width > 0) || !(info.height > 0)) return undefined;
  return info;
}

function readRawHeader(buf: Uint8Array, format: SniffedImageFormat): ImageHeaderInfo | undefined {
  switch (format) {
    case "png":
      if (buf.length < 24 || ascii(buf, 12, 4) !== "IHDR") return undefined;
      return { width: u32be(buf, 16), height: u32be(buf, 20) };
    case "gif":
      if (buf.length < 10) return undefined;
      return { width: u16le(buf, 6), height: u16le(buf, 8) };
    case "bmp": {
      const dibSize = buf.length >= 18 ? (buf[14] | (buf[15] << 8) | (buf[16] << 16) | (buf[17] << 24)) : 0;
      if (dibSize === 12) {
        if (buf.length < 22) return undefined;
        return { width: u16le(buf, 18), height: u16le(buf, 20) };
      }
      if (buf.length < 26) return undefined;
      return { width: Math.abs(i32le(buf, 18)), height: Math.abs(i32le(buf, 22)) };
    }
    case "webp":
      return readWebpHeader(buf);
    case "jpeg":
      return readJpegHeader(buf);
  }
}

function readWebpHeader(buf: Uint8Array): ImageHeaderInfo | undefined {
  if (buf.length < 30) return undefined;
  const chunk = ascii(buf, 12, 4);
  if (chunk === "VP8 ") {
    return { width: u16le(buf, 26) & 0x3fff, height: u16le(buf, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return undefined;
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") {
    return { width: 1 + u24le(buf, 24), height: 1 + u24le(buf, 27) };
  }
  return undefined;
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readJpegHeader(buf: Uint8Array): ImageHeaderInfo | undefined {
  let offset = 2;
  let orientation: number | undefined;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return undefined;
    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) {
      offset++;
      marker = buf[offset + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(buf, offset + 2);
    if (length < 2) return undefined;
    const segment = offset + 4;
    if (marker === 0xe1 && orientation === undefined) orientation = readExifOrientation(buf, segment, length - 2);
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segment + 5 > buf.length) return undefined;
      return { height: u16be(buf, segment + 1), width: u16be(buf, segment + 3), orientation };
    }
    offset += 2 + length;
  }
  return undefined;
}

function readExifOrientation(buf: Uint8Array, start: number, length: number): number | undefined {
  const end = Math.min(buf.length, start + length);
  if (start + 14 > end || ascii(buf, start, 6) !== "Exif\0\0") return undefined;
  const tiff = start + 6;
  const order = ascii(buf, tiff, 2);
  const little = order === "II";
  if (!little && order !== "MM") return undefined;
  const r16 = (o: number) => (little ? u16le(buf, o) : u16be(buf, o));
  const r32 = (o: number) => (little ? (u16le(buf, o) + u16le(buf, o + 2) * 0x10000) : u32be(buf, o));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return undefined;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return undefined;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

function orientedSize(info: ImageHeaderInfo): { width: number; height: number } {
  return info.orientation !== undefined && info.orientation >= 5
    ? { width: info.height, height: info.width }
    : { width: info.width, height: info.height };
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

export type PreflightResult =
  | { kind: "error"; code: ImagePrepareErrorCode; message: string }
  | { kind: "unchanged"; image: PreparedImage }
  | { kind: "transform"; format: SniffedImageFormat; header: ImageHeaderInfo; source: PreparedImageSource };

/** Cheap checks that run without decoding. Decides whether the original bytes can be sent. */
export function preflightImage(buf: Uint8Array): PreflightResult {
  const format = sniffImageFormat(buf);
  if (!format) {
    return {
      kind: "error",
      code: "UNSUPPORTED_IMAGE_TYPE",
      message: "File content is not a supported raster image. Supported formats (detected from the file bytes, not the extension): PNG, JPEG, GIF, WebP, BMP. For SVG (XML text) use read_files instead.",
    };
  }
  const header = readImageHeader(buf, format);
  if (!header) {
    return { kind: "error", code: "IMAGE_DECODE_FAILED", message: `Could not read the ${format.toUpperCase()} header; the file may be truncated or corrupt.` };
  }
  const pixels = header.width * header.height;
  if (pixels > IMAGE_MAX_PIXELS) {
    return {
      kind: "error",
      code: "IMAGE_TOO_LARGE",
      message: `Image is ${header.width}×${header.height} (${(pixels / 1_000_000).toFixed(1)} megapixels), above the ${IMAGE_MAX_PIXELS / 1_000_000} megapixel decode limit. Reduce it out-of-band and retry.`,
    };
  }
  const shown = orientedSize(header);
  const source: PreparedImageSource = { format, mimeType: IMAGE_MIME_BY_FORMAT[format], width: shown.width, height: shown.height, bytes: buf.length };
  const needsOrientation = header.orientation !== undefined && header.orientation !== 1;
  if (
    PASSTHROUGH_FORMATS.has(format)
    && Math.max(header.width, header.height) <= IMAGE_MAX_EDGE
    && base64Length(buf.length) <= IMAGE_MAX_BASE64_BYTES
    && !needsOrientation
  ) {
    return {
      kind: "unchanged",
      image: { data: Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), mimeType: source.mimeType, width: shown.width, height: shown.height, unchanged: true, source, notes: [] },
    };
  }
  return { kind: "transform", format, header, source };
}

type Photon = typeof PhotonModule;

/** Full preparation. `loadPhoton` is only called when the image must be re-encoded. */
export function prepareImage(buf: Uint8Array, loadPhoton: () => Photon): ImagePrepareResult {
  const pre = preflightImage(buf);
  if (pre.kind === "error") return { ok: false, code: pre.code, message: pre.message };
  if (pre.kind === "unchanged") return { ok: true, image: pre.image };
  try {
    return transformImage(buf, pre.format, pre.header, pre.source, loadPhoton());
  } catch (err) {
    return { ok: false, code: "IMAGE_PROCESSING_FAILED", message: `Image processing failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function transformImage(
  buf: Uint8Array,
  format: SniffedImageFormat,
  header: ImageHeaderInfo,
  source: PreparedImageSource,
  photon: Photon,
): ImagePrepareResult {
  let decoded: PhotonModule.PhotonImage;
  try {
    decoded = photon.PhotonImage.new_from_byteslice(buf);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "IMAGE_DECODE_FAILED", message: `Could not decode the ${format.toUpperCase()} image; the file may be corrupt or use an unsupported variant (${detail}).` };
  }
  const notes: string[] = [];
  if (format === "gif") notes.push("GIF converted to PNG; only the first frame is shown.");
  if (format === "bmp") notes.push("BMP converted to PNG.");
  if (header.orientation !== undefined && header.orientation !== 1) notes.push(`EXIF orientation ${header.orientation} applied.`);
  try {
    const storedW = decoded.get_width();
    const storedH = decoded.get_height();
    const storedLong = Math.max(storedW, storedH);
    let edge = Math.min(storedLong, IMAGE_MAX_EDGE);
    const preferPng = PNG_PREFERRED_FORMATS.has(format);
    for (;;) {
      const scale = edge / storedLong;
      const w = Math.max(1, Math.round(storedW * scale));
      const h = Math.max(1, Math.round(storedH * scale));
      const resized = scale < 1 ? photon.resize(decoded, w, h, photon.SamplingFilter.Lanczos3) : undefined;
      const working = resized ?? decoded;
      try {
        const oriented = orientPixels(working.get_raw_pixels(), w, h, header.orientation);
        const out = encodeWithinBudget(photon, oriented, preferPng);
        if (out) {
          if (out.mimeType === "image/jpeg" && preferPng) notes.push("Re-encoded as JPEG to fit the size budget.");
          return {
            ok: true,
            image: { data: Buffer.from(out.data), mimeType: out.mimeType, width: oriented.width, height: oriented.height, unchanged: false, source, notes },
          };
        }
      } finally {
        resized?.free();
      }
      const next = Math.floor(edge * SHRINK_FACTOR);
      if (next < MIN_EDGE) break;
      edge = next;
    }
    return { ok: false, code: "IMAGE_TOO_LARGE", message: `Could not fit the image under the ${formatByteSize(IMAGE_MAX_BASE64_BYTES)} base64 budget even at ${MIN_EDGE}px.` };
  } finally {
    decoded.free();
  }
}

interface RawImage { pixels: Uint8Array; width: number; height: number }

function encodeWithinBudget(photon: Photon, raw: RawImage, preferPng: boolean): { data: Uint8Array; mimeType: string } | undefined {
  const fits = (data: Uint8Array) => base64Length(data.length) <= IMAGE_MAX_BASE64_BYTES;
  if (preferPng) {
    const img = new photon.PhotonImage(raw.pixels, raw.width, raw.height);
    try {
      const png = img.get_bytes();
      if (fits(png)) return { data: png, mimeType: "image/png" };
    } finally {
      img.free();
    }
  }
  const flattened = flattenAlpha(raw.pixels);
  const img = new photon.PhotonImage(flattened, raw.width, raw.height);
  try {
    for (const quality of IMAGE_JPEG_QUALITIES) {
      const jpeg = img.get_bytes_jpeg(quality);
      if (fits(jpeg)) return { data: jpeg, mimeType: "image/jpeg" };
    }
  } finally {
    img.free();
  }
  return undefined;
}

/** JPEG has no alpha channel: composite translucent pixels onto white. */
function flattenAlpha(pixels: Uint8Array): Uint8Array {
  let translucent = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 255) { translucent = true; break; }
  }
  if (!translucent) return pixels;
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    const inv = 255 - a;
    out[i] = Math.round((pixels[i] * a + 255 * inv) / 255);
    out[i + 1] = Math.round((pixels[i + 1] * a + 255 * inv) / 255);
    out[i + 2] = Math.round((pixels[i + 2] * a + 255 * inv) / 255);
    out[i + 3] = 255;
  }
  return out;
}

/** Applies EXIF orientation to raw RGBA pixels. */
export function orientPixels(pixels: Uint8Array, width: number, height: number, orientation: number | undefined): RawImage {
  if (orientation === undefined || orientation <= 1 || orientation > 8) return { pixels, width, height };
  const swap = orientation >= 5;
  const outW = swap ? height : width;
  const outH = swap ? width : height;
  const aligned = pixels.byteOffset % 4 === 0 ? pixels : pixels.slice();
  const out = new Uint8Array(pixels.length);
  const src = new Uint32Array(aligned.buffer, aligned.byteOffset, width * height);
  const dst = new Uint32Array(out.buffer, 0, width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx: number, dy: number;
      switch (orientation) {
        case 2: dx = width - 1 - x; dy = y; break;
        case 3: dx = width - 1 - x; dy = height - 1 - y; break;
        case 4: dx = x; dy = height - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = height - 1 - y; dy = x; break;
        case 7: dx = height - 1 - y; dy = width - 1 - x; break;
        default: dx = y; dy = width - 1 - x; break; // 8
      }
      dst[dy * outW + dx] = src[y * width + x];
    }
  }
  return { pixels: out, width: outW, height: outH };
}
