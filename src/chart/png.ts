import { deflateSync } from "node:zlib";

/**
 * Minimal PNG encoder — the only thing standing between our raster buffer
 * and a Discord-embeddable image.
 *
 * Why hand-rolled rather than a library: every JS canvas/SVG-rasterizer
 * option (canvas, sharp, resvg) pulls a native binary dependency, which
 * means a compile step, platform-specific binaries, and a real chance of a
 * broken install on a Windows box. PNG's container format is simple enough
 * (four chunks, CRC32, and zlib — which Node ships) that encoding it
 * directly is both smaller and more reliable than any of those. Discord
 * does NOT render SVG attachments inline, so PNG is the required output.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Standard CRC-32 table (PNG uses the same polynomial as zip/zlib). */
const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk is length + type + data + CRC(type+data). */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encodes a tightly-packed RGB buffer (3 bytes per pixel, row-major) as a
 * PNG. Uses filter type 0 (None) on every scanline — the charts we render
 * are large flat-color regions, which zlib already compresses well, so the
 * added complexity of adaptive filtering buys very little here.
 */
export function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodePng: buffer is ${rgb.length} bytes, expected ${width * height * 3} for ${width}x${height} RGB`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type 2 = truecolor RGB
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter method: adaptive (with per-scanline type below)
  ihdr.writeUInt8(0, 12); // interlace: none

  // Prefix each scanline with its filter byte (0 = None).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
