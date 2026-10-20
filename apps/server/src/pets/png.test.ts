import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import { decodePng, encodePng, PngDecodeError } from "./png.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(NodeZlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

function buildPng(input: {
  width: number;
  height: number;
  colorType: number;
  interlace?: number;
  raw: Buffer;
  extra?: Buffer[];
}): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(input.width, 0);
  header.writeUInt32BE(input.height, 4);
  header[8] = 8;
  header[9] = input.colorType;
  header[12] = input.interlace ?? 0;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    ...(input.extra ?? []),
    chunk("IDAT", NodeZlib.deflateSync(input.raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("png", () => {
  it("round-trips RGBA pixels", () => {
    const data = new Uint8ClampedArray(3 * 2 * 4).map((_, i) => (i * 37) % 256);
    const decoded = decodePng(encodePng({ width: 3, height: 2, channels: 4, data }));
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.data)).toEqual(Array.from(data));
  });

  it("decodes RGB with opaque alpha", () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const decoded = decodePng(encodePng({ width: 2, height: 1, channels: 3, data }));
    expect(Array.from(decoded.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it("applies scanline filters 1 to 4", () => {
    // 2x4 RGB image; each row uses a different filter. Pixels are (r,g,b).
    const rows = [
      [10, 20, 30, 40, 50, 60],
      [5, 5, 5, 6, 6, 6],
      [7, 8, 9, 10, 11, 12],
      [1, 2, 3, 4, 5, 6],
    ];
    const raw = Buffer.from(
      [
        // Sub: each byte adds the byte 3 to the left.
        1,
        10,
        20,
        30,
        30,
        30,
        30,
        // Up: adds the byte above (row 0 decoded).
        2,
        5 - 10,
        5 - 20,
        5 - 30,
        6 - 40,
        6 - 50,
        6 - 60,
        // Average of left and up (row 1 decoded = [5,5,5,6,6,6]).
        3,
        7 - 2,
        8 - 2,
        9 - 2,
        10 - Math.floor((7 + 6) / 2),
        11 - Math.floor((8 + 6) / 2),
        12 - Math.floor((9 + 6) / 2),
        // Paeth against row 2 decoded.
        4,
        1 - 7,
        2 - 8,
        3 - 9,
        4 - paeth(1, 10, 7),
        5 - paeth(2, 11, 8),
        6 - paeth(3, 12, 9),
      ].map((value) => value & 0xff),
    );
    const decoded = decodePng(buildPng({ width: 2, height: 4, colorType: 2, raw }));
    const expected = rows.flatMap((row) => [
      row[0],
      row[1],
      row[2],
      255,
      row[3],
      row[4],
      row[5],
      255,
    ]);
    expect(Array.from(decoded.data)).toEqual(expected);
  });

  it("decodes palette images with tRNS", () => {
    const palette = chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0]));
    const trns = chunk("tRNS", Buffer.from([128]));
    const decoded = decodePng(
      buildPng({
        width: 2,
        height: 1,
        colorType: 3,
        raw: Buffer.from([0, 0, 1]),
        extra: [palette, trns],
      }),
    );
    expect(Array.from(decoded.data)).toEqual([255, 0, 0, 128, 0, 255, 0, 255]);
  });

  it("rejects interlaced images", () => {
    const png = buildPng({ width: 1, height: 1, colorType: 6, interlace: 1, raw: Buffer.alloc(5) });
    expect(() => decodePng(png)).toThrow(PngDecodeError);
  });

  it("rejects dimensions beyond the cap", () => {
    const png = buildPng({ width: 100000, height: 1, colorType: 6, raw: Buffer.alloc(5) });
    expect(() => decodePng(png)).toThrow(PngDecodeError);
  });

  it("decodes image data split across IDAT chunks", () => {
    const raw = Buffer.from([0, 1, 2, 3, 4, 5, 6]);
    const compressed = NodeZlib.deflateSync(raw);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 2;
    const png = Buffer.concat([
      SIGNATURE,
      chunk("IHDR", header),
      chunk("IDAT", compressed.subarray(0, 4)),
      chunk("IDAT", compressed.subarray(4)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(Array.from(decodePng(png).data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it("rejects a bad CRC", () => {
    const png = Buffer.from(
      encodePng({ width: 1, height: 1, channels: 4, data: new Uint8Array(4) }),
    );
    png.writeUInt8(~png.readUInt8(png.length - 1) & 0xff, png.length - 1);
    expect(() => decodePng(png)).toThrow(PngDecodeError);
  });
});

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
