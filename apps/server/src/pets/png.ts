/**
 * The server's one PNG codec, in plain TypeScript so pet atlases can be read and
 * written without a native image library. Decoding covers the 8-bit,
 * non-interlaced PNGs that image tools export; anything else is rejected.
 */
import * as NodeZlib from "node:zlib";

export type RgbaImage = {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel. */
  readonly data: Uint8ClampedArray;
};

export class PngDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngDecodeError";
  }
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Encodes raw 8-bit gray, RGB, or RGBA pixels as a PNG. */
export function encodePng(image: {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 3 | 4;
  readonly data: Uint8Array | Uint8ClampedArray;
}): Uint8Array {
  const { width, height, channels, data } = image;
  const stride = width * channels;
  // Every row starts with filter type 0 (none).
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw.set(data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(NodeZlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decodes an 8-bit, non-interlaced RGB, RGBA, or palette PNG to RGBA pixels. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || SIGNATURE.some((value, index) => buffer[index] !== value))
    throw new PngDecodeError("Not a PNG file.");

  let header: Buffer | undefined;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new PngDecodeError("The PNG is truncated.");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (
      NodeZlib.crc32(buffer.subarray(offset + 4, offset + 8 + length)) !==
      buffer.readUInt32BE(end - 4)
    )
      throw new PngDecodeError(`The PNG has a bad checksum in its ${type} chunk.`);
    if (type === "IHDR") header = body;
    else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset = end;
  }

  if (header === undefined || header.length < 13) throw new PngDecodeError("The PNG has no IHDR.");
  if (idat.length === 0) throw new PngDecodeError("The PNG has no image data.");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  if (header[12] !== 0) throw new PngDecodeError("Interlaced PNGs are not supported.");
  if (bitDepth !== 8) throw new PngDecodeError("Only 8-bit PNGs are supported.");
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 3 ? 1 : 0;
  if (channels === 0) throw new PngDecodeError(`PNG color type ${colorType} is not supported.`);
  if (colorType === 3 && palette === undefined)
    throw new PngDecodeError("The palette PNG has no PLTE.");
  if (width === 0 || height === 0) throw new PngDecodeError("The PNG is empty.");

  const stride = width * channels;
  let inflated: Buffer;
  try {
    inflated = NodeZlib.inflateSync(Buffer.concat(idat));
  } catch {
    throw new PngDecodeError("The PNG image data is corrupt.");
  }
  if (inflated.length < (stride + 1) * height)
    throw new PngDecodeError("The PNG image data is too short.");

  // Unfilter in place into `pixels`, one row at a time (rows reference the previous row).
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = inflated[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    const above = target - stride;
    for (let i = 0; i < stride; i++) {
      const raw = inflated[source + i] ?? 0;
      const left = i >= channels ? (pixels[target + i - channels] ?? 0) : 0;
      const up = row > 0 ? (pixels[above + i] ?? 0) : 0;
      const upLeft = row > 0 && i >= channels ? (pixels[above + i - channels] ?? 0) : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const distanceLeft = Math.abs(estimate - left);
          const distanceUp = Math.abs(estimate - up);
          const distanceUpLeft = Math.abs(estimate - upLeft);
          predictor =
            distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
              ? left
              : distanceUp <= distanceUpLeft
                ? up
                : upLeft;
          break;
        }
        default:
          throw new PngDecodeError(`The PNG uses an unknown filter type ${filter}.`);
      }
      pixels[target + i] = (raw + predictor) & 0xff;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const out = pixel * 4;
    const index = pixel * channels;
    if (colorType === 6) {
      data.set(pixels.subarray(index, index + 4), out);
    } else if (colorType === 2) {
      data[out] = pixels[index] ?? 0;
      data[out + 1] = pixels[index + 1] ?? 0;
      data[out + 2] = pixels[index + 2] ?? 0;
      data[out + 3] = 255;
    } else {
      const entry = (pixels[index] ?? 0) * 3;
      if (palette === undefined || entry + 3 > palette.length)
        throw new PngDecodeError("The PNG uses a palette entry that does not exist.");
      data[out] = palette[entry] ?? 0;
      data[out + 1] = palette[entry + 1] ?? 0;
      data[out + 2] = palette[entry + 2] ?? 0;
      data[out + 3] = transparency?.[pixels[index] ?? 0] ?? 255;
    }
  }
  return { width, height, data };
}
