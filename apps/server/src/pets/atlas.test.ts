import { PET_ATLAS, PET_ROWS, type PetRowName } from "@mybot/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AtlasError,
  assembleAtlasFromStrips,
  composeAtlas,
  fitFrame,
  removeChromaKey,
  splitStrip,
} from "./atlas.ts";
import { decodePng, encodePng, type RgbaImage } from "./png.ts";

function blank(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, rgba: number[]) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) img.data.set(rgba, (yy * img.width + xx) * 4);
}

/** A green strip with `count` red squares, `gap` pixels apart (negative = touching). */
function greenStrip(count: number, size = 20, gap = 20, height = 40): RgbaImage {
  const width = count * size + (count + 1) * gap;
  const img = blank(width, height, [0, 255, 0, 255]);
  for (let i = 0; i < count; i++)
    fillRect(img, gap + i * (size + gap), 10, size, size, [255, 0, 0, 255]);
  return img;
}

function opaqueCount(img: RgbaImage): number {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) n++;
  return n;
}

function cell(atlas: RgbaImage, row: number, col: number): RgbaImage {
  const { cellWidth: w, cellHeight: h } = PET_ATLAS;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((row * h + y) * atlas.width + col * w) * 4;
    data.set(atlas.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

function allRows(skip: PetRowName[] = []): Map<PetRowName, RgbaImage[]> {
  const rows = new Map<PetRowName, RgbaImage[]>();
  for (const r of PET_ROWS) {
    if (skip.includes(r.name)) continue;
    const frames = r.frameDurationsMs.map((_, i) => {
      const img = blank(30, 30, [0, 0, 0, 0]);
      fillRect(img, 0, 0, 10 + (i % 3), 20, [255, 0, 0, 255]);
      return img;
    });
    rows.set(r.name, frames);
  }
  return rows;
}

describe("removeChromaKey", () => {
  it("clears green and keeps red", () => {
    const out = removeChromaKey(greenStrip(6));
    expect([...out.data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    const red = (20 * out.width + 25) * 4;
    expect([...out.data.subarray(red, red + 4)]).toEqual([255, 0, 0, 255]);
  });
});

describe("splitStrip", () => {
  it("returns one frame per square", () => {
    const frames = splitStrip(removeChromaKey(greenStrip(6)), 6);
    expect(frames).toHaveLength(6);
    for (const f of frames) expect(opaqueCount(f)).toBe(400);
  });

  it("falls back to equal slices when squares touch", () => {
    const strip = removeChromaKey(greenStrip(6, 20, 0));
    const frames = splitStrip(strip, 6);
    expect(frames).toHaveLength(6);
    for (const f of frames) expect(f.width).toBe(20);
  });
});

describe("fitFrame", () => {
  it("bottom-aligns with an 8px margin and centers", () => {
    const img = blank(40, 40, [0, 0, 0, 0]);
    fillRect(img, 5, 5, 10, 20, [255, 0, 0, 255]);
    const out = fitFrame(img, 1);
    expect([out.width, out.height]).toEqual([192, 208]);
    const a = (x: number, y: number) => out.data[(y * 192 + x) * 4 + 3];
    expect(a(91, 207 - 8)).toBe(255);
    expect(a(91, 208 - 8)).toBe(0);
    expect(a(91, 208 - 8 - 21)).toBe(0);
    expect(a(91, 208 - 8 - 20)).toBe(255);
    expect(a(91, 190)).toBe(255);
    expect(a(90, 190)).toBe(0);
    expect(a(100, 190)).toBe(255);
    expect(a(101, 190)).toBe(0);
  });
});

describe("composeAtlas", () => {
  it("lays out frames in a 1536x1872 atlas", () => {
    const atlas = composeAtlas(allRows());
    expect([atlas.width, atlas.height]).toEqual([1536, 1872]);
    expect(opaqueCount(cell(atlas, 7, 0))).toBeGreaterThan(0);
    expect(opaqueCount(cell(atlas, 0, 7))).toBe(0);
  });

  it("mirrors running-right when running-left is omitted", () => {
    const atlas = composeAtlas(allRows(["running-left"]));
    const right = cell(atlas, 1, 0);
    const left = cell(atlas, 2, 0);
    expect(opaqueCount(left)).toBeGreaterThan(0);
    for (let y = 0; y < 208; y++)
      for (let x = 0; x < 192; x++)
        expect([...left.data.subarray((y * 192 + x) * 4, (y * 192 + x) * 4 + 4)]).toEqual([
          ...right.data.subarray((y * 192 + 191 - x) * 4, (y * 192 + 191 - x) * 4 + 4),
        ]);
  });

  it("names the missing row", () => {
    try {
      composeAtlas(allRows(["failed"]));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AtlasError);
      expect((e as AtlasError).row).toBe("failed");
    }
  });

  it("rejects a wrong frame count", () => {
    const rows = allRows();
    rows.set("idle", rows.get("idle")!.slice(1));
    expect(() => composeAtlas(rows)).toThrow(AtlasError);
  });
});

describe("assembleAtlasFromStrips", () => {
  it("builds a PNG atlas, deriving running-left", () => {
    const strips = new Map<PetRowName, Uint8Array>();
    for (const r of PET_ROWS) {
      if (r.name === "running-left") continue;
      const s = greenStrip(r.frameDurationsMs.length);
      strips.set(
        r.name,
        encodePng({ width: s.width, height: s.height, channels: 4, data: s.data }),
      );
    }
    const atlas = decodePng(assembleAtlasFromStrips(strips));
    expect([atlas.width, atlas.height]).toEqual([1536, 1872]);
    expect(opaqueCount(cell(atlas, 2, 7))).toBeGreaterThan(0);
  });
});
