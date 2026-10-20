/**
 * Turns generated animation strips (one horizontal PNG per pet state on a flat
 * green background) into the 8-column sprite atlas Codex-style pets use.
 */
import { PET_ATLAS, PET_ROWS, type PetRowName } from "@mybot/contracts";

import { decodePng, encodePng, type RgbaImage } from "./png.ts";

export class AtlasError extends Error {
  readonly row?: PetRowName;
  constructor(message: string, row?: PetRowName) {
    super(message);
    this.name = "AtlasError";
    if (row !== undefined) this.row = row;
  }
}

const { cellWidth: CELL_W, cellHeight: CELL_H, columns: COLUMNS } = PET_ATLAS;
const FIT_W = 176;
const FIT_H = 192;
const BOTTOM_MARGIN = 8;
/** Columns with alpha at or below this count as empty when finding frame bounds. */
const ALPHA_CUTOFF = 8;

const TRANSPARENT: readonly [number, number, number, number] = [0, 0, 0, 0];

/** Makes every pixel within `threshold` RGB distance of `key` fully transparent. */
export function removeChromaKey(
  image: RgbaImage,
  key: readonly [number, number, number] = [0, 255, 0],
  threshold = 96,
): RgbaImage {
  const data = new Uint8ClampedArray(image.data);
  const limit = threshold * threshold;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i]! - key[0];
    const dg = data[i + 1]! - key[1];
    const db = data[i + 2]! - key[2];
    if (dr * dr + dg * dg + db * db <= limit) data.set(TRANSPARENT, i);
  }
  return { width: image.width, height: image.height, data };
}

function cropColumns(image: RgbaImage, from: number, to: number): RgbaImage {
  const width = to - from;
  const data = new Uint8ClampedArray(width * image.height * 4);
  for (let y = 0; y < image.height; y++) {
    const src = (y * image.width + from) * 4;
    data.set(image.data.subarray(src, src + width * 4), y * width * 4);
  }
  return { width, height: image.height, data };
}

function equalSlices(strip: RgbaImage, frames: number): RgbaImage[] {
  const out: RgbaImage[] = [];
  for (let i = 0; i < frames; i++) {
    out.push(
      cropColumns(
        strip,
        Math.round((i * strip.width) / frames),
        Math.round(((i + 1) * strip.width) / frames),
      ),
    );
  }
  return out;
}

/**
 * Splits a keyed strip into `frames` images using the columns that hold opaque
 * pixels, merging gaps under 2% of the width. Falls back to equal-width slices
 * when the groups do not come out to `frames`.
 */
export function splitStrip(strip: RgbaImage, frames: number): RgbaImage[] {
  const occupied = Array.from({ length: strip.width }, () => false);
  for (let y = 0; y < strip.height; y++) {
    for (let x = 0; x < strip.width; x++) {
      if (strip.data[(y * strip.width + x) * 4 + 3]! > ALPHA_CUTOFF) occupied[x] = true;
    }
  }
  const minGap = Math.max(1, Math.ceil(strip.width * 0.02));
  const groups: Array<[number, number]> = [];
  for (let x = 0; x < strip.width; x++) {
    if (!occupied[x]) continue;
    const last = groups[groups.length - 1];
    if (last && x - last[1] < minGap) last[1] = x + 1;
    else groups.push([x, x + 1]);
  }
  if (groups.length !== frames) return equalSlices(strip, frames);
  return groups.map(([from, to]) => cropColumns(strip, from, to));
}

type Bounds = { x: number; y: number; width: number; height: number };

function alphaBounds(image: RgbaImage): Bounds | null {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (!image.data[(y * image.width + x) * 4 + 3]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Area-average resize of a region, weighting colour by alpha so edges stay clean. */
function resizeRegion(image: RgbaImage, b: Bounds, outW: number, outH: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = b.width / outW;
  const sy = b.height / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = b.y + oy * sy;
    const y1 = y0 + sy;
    for (let ox = 0; ox < outW; ox++) {
      const x0 = b.x + ox * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let bl = 0;
      let a = 0;
      let weight = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const p = (y * image.width + x) * 4;
          const alpha = image.data[p + 3]! * w;
          r += image.data[p]! * alpha;
          g += image.data[p + 1]! * alpha;
          bl += image.data[p + 2]! * alpha;
          a += alpha;
          weight += w;
        }
      }
      const o = (oy * outW + ox) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = bl / a;
        out[o + 3] = a / weight;
      }
    }
  }
  return out;
}

/** Crops to the visible pixels, scales, and places on a cell: centred, 8px above the bottom. */
export function fitFrame(frame: RgbaImage, scale: number): RgbaImage {
  const cell = new Uint8ClampedArray(CELL_W * CELL_H * 4);
  const bounds = alphaBounds(frame);
  if (bounds) {
    const outW = Math.min(CELL_W, Math.max(1, Math.round(bounds.width * scale)));
    const outH = Math.min(CELL_H - BOTTOM_MARGIN, Math.max(1, Math.round(bounds.height * scale)));
    const pixels = resizeRegion(frame, bounds, outW, outH);
    const left = Math.floor((CELL_W - outW) / 2);
    const top = CELL_H - BOTTOM_MARGIN - outH;
    for (let y = 0; y < outH; y++) {
      cell.set(pixels.subarray(y * outW * 4, (y + 1) * outW * 4), ((top + y) * CELL_W + left) * 4);
    }
  }
  return { width: CELL_W, height: CELL_H, data: cell };
}

function mirror(image: RgbaImage): RgbaImage {
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const src = (y * image.width + x) * 4;
      data.set(image.data.subarray(src, src + 4), (y * image.width + (image.width - 1 - x)) * 4);
    }
  }
  return { width: image.width, height: image.height, data };
}

/**
 * Builds the full atlas. One scale is shared by every frame so the pet keeps its
 * size across animations. A missing running-left row is the mirrored running-right.
 */
export function composeAtlas(rows: ReadonlyMap<PetRowName, RgbaImage[]>): RgbaImage {
  const derivedLeft = !rows.has("running-left");
  const source = new Map<PetRowName, RgbaImage[]>();
  for (const { name, frameDurationsMs } of PET_ROWS) {
    if (name === "running-left" && derivedLeft) continue;
    const frames = rows.get(name);
    if (!frames) throw new AtlasError(`Missing ${name} frames`, name);
    if (frames.length !== frameDurationsMs.length) {
      throw new AtlasError(
        `${name} needs ${frameDurationsMs.length} frames, got ${frames.length}`,
        name,
      );
    }
    source.set(name, frames);
  }

  let scale = Infinity;
  for (const frames of source.values()) {
    for (const frame of frames) {
      const b = alphaBounds(frame);
      if (b) scale = Math.min(scale, FIT_W / b.width, FIT_H / b.height);
    }
  }
  if (!Number.isFinite(scale)) throw new AtlasError("The strips contain no visible pixels");

  const width = PET_ATLAS.v1.width;
  const height = PET_ATLAS.v1.height;
  const data = new Uint8ClampedArray(width * height * 4);
  const place = (row: number, col: number, cell: RgbaImage) => {
    for (let y = 0; y < CELL_H; y++) {
      data.set(
        cell.data.subarray(y * CELL_W * 4, (y + 1) * CELL_W * 4),
        ((row * CELL_H + y) * width + col * CELL_W) * 4,
      );
    }
  };
  for (const { name, row } of PET_ROWS) {
    const frames = source.get(name) ?? source.get("running-right")!;
    if (frames.length > COLUMNS) throw new AtlasError(`${name} has too many frames`, name);
    frames.forEach((frame, col) => {
      const cell = fitFrame(frame, scale);
      place(row, col, source.has(name) ? cell : mirror(cell));
    });
  }
  return { width, height, data };
}

/** Decodes, keys out the background, splits and composes strips into atlas PNG bytes. */
export function assembleAtlasFromStrips(strips: ReadonlyMap<PetRowName, Uint8Array>): Uint8Array {
  const rows = new Map<PetRowName, RgbaImage[]>();
  for (const { name, frameDurationsMs } of PET_ROWS) {
    const bytes = strips.get(name);
    if (!bytes) continue;
    let strip: RgbaImage;
    try {
      strip = decodePng(bytes);
    } catch (cause) {
      throw new AtlasError(`Could not read the ${name} strip: ${(cause as Error).message}`, name);
    }
    rows.set(name, splitStrip(removeChromaKey(strip), frameDurationsMs.length));
  }
  const atlas = composeAtlas(rows);
  return encodePng({ width: atlas.width, height: atlas.height, channels: 4, data: atlas.data });
}
