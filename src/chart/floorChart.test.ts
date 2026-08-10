import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { Canvas, rgb } from "./canvas.js";
import { renderFloorChart } from "./floorChart.js";
import { encodePng } from "./png.js";

const PNG_SIGNATURE = "89504e470d0a1a0a";

function samples(count: number, start = 0.4, step = 0.01) {
  const base = Date.parse("2026-08-10T00:00:00Z");
  return Array.from({ length: count }, (_, i) => ({
    t: new Date(base + i * 3_600_000).toISOString(),
    floor: Number((start + i * step).toFixed(4)),
    volume: 5 + i,
  }));
}

test("encodePng: emits a valid PNG signature and the four required chunks in order", () => {
  const png = encodePng(new Uint8Array(4 * 4 * 3), 4, 4);
  assert.equal(png.subarray(0, 8).toString("hex"), PNG_SIGNATURE);

  const body = png.toString("latin1");
  const ihdr = body.indexOf("IHDR");
  const idat = body.indexOf("IDAT");
  const iend = body.indexOf("IEND");
  assert.ok(ihdr > 0 && idat > ihdr && iend > idat, "chunks must appear as IHDR, IDAT, IEND");
});

test("encodePng: IHDR carries the right dimensions and color type", () => {
  const png = encodePng(new Uint8Array(7 * 3 * 3), 7, 3);
  // 8-byte signature + 4-byte length + 4-byte "IHDR" = data starts at 16.
  assert.equal(png.readUInt32BE(16), 7); // width
  assert.equal(png.readUInt32BE(20), 3); // height
  assert.equal(png.readUInt8(24), 8); // bit depth
  assert.equal(png.readUInt8(25), 2); // color type 2 = truecolor RGB
});

test("encodePng: pixel data round-trips through the zlib stream intact", () => {
  // A red pixel and a blue pixel — decoding proves both the scanline filter
  // byte and the RGB byte order are written correctly.
  const rgbData = new Uint8Array([255, 0, 0, 0, 0, 255]);
  const png = encodePng(rgbData, 2, 1);

  const body = png.toString("latin1");
  const idatStart = body.indexOf("IDAT") + 4;
  const idatLength = png.readUInt32BE(body.indexOf("IDAT") - 4);
  const decompressed = inflateSync(png.subarray(idatStart, idatStart + idatLength));

  assert.equal(decompressed[0], 0, "scanline must be prefixed with filter type 0");
  assert.deepEqual([...decompressed.subarray(1)], [255, 0, 0, 0, 0, 255]);
});

test("encodePng: rejects a buffer whose length doesn't match the dimensions", () => {
  assert.throws(() => encodePng(new Uint8Array(10), 4, 4), /expected/);
});

test("Canvas: textWidth accounts for glyph spacing and scale", () => {
  assert.equal(Canvas.textWidth(""), 0);
  assert.equal(Canvas.textWidth("A"), 5);
  assert.equal(Canvas.textWidth("AB"), 11); // 5 + 1 spacing + 5
  assert.equal(Canvas.textWidth("AB", 2), 22);
});

test("Canvas: drawing stays in bounds for out-of-range coordinates", () => {
  const canvas = new Canvas(8, 8, rgb(0x000000));
  // None of these should throw or corrupt memory.
  canvas.setPixel(-5, -5, rgb(0xffffff));
  canvas.setPixel(100, 100, rgb(0xffffff));
  canvas.fillRect(-10, -10, 5, 5, rgb(0xffffff));
  canvas.line(-20, -20, 40, 40, rgb(0xffffff));
  canvas.text(-3, -3, "clipped", rgb(0xffffff));

  assert.equal(canvas.toPng().subarray(0, 8).toString("hex"), PNG_SIGNATURE);
});

test("renderFloorChart: returns a PNG for a normal series", () => {
  const png = renderFloorChart({
    collectionName: "Super Punk World",
    currency: "ETH",
    samples: samples(24),
    windowLabel: "past 24h",
  });

  assert.ok(png, "expected a chart buffer");
  assert.equal(png!.subarray(0, 8).toString("hex"), PNG_SIGNATURE);
  assert.ok(png!.length > 1000, "a real chart should be more than a trivial image");
});

test("renderFloorChart: returns null rather than a misleading chart when history is too thin", () => {
  // A brand-new collection legitimately has no history; the caller posts the
  // digest without an image instead of plotting a single point as a "trend".
  assert.equal(renderFloorChart({ collectionName: "New", currency: "ETH", samples: [], windowLabel: "past 24h" }), null);
  assert.equal(renderFloorChart({ collectionName: "New", currency: "ETH", samples: samples(1), windowLabel: "past 24h" }), null);
});

test("renderFloorChart: handles a perfectly flat series without dividing by zero", () => {
  const flat = samples(10, 0.5, 0);
  const png = renderFloorChart({ collectionName: "Flat", currency: "ETH", samples: flat, windowLabel: "past 24h" });
  assert.ok(png);
  assert.equal(png!.subarray(0, 8).toString("hex"), PNG_SIGNATURE);
});

test("renderFloorChart: tolerates a series with no volume data", () => {
  const noVolume = samples(6).map(({ t, floor }) => ({ t, floor }));
  const png = renderFloorChart({ collectionName: "No volume", currency: "ETH", samples: noVolume, windowLabel: "past 24h" });
  assert.ok(png);
});

test("renderFloorChart: skips non-finite floor readings instead of rendering NaN", () => {
  const dirty = [...samples(4), { t: "2026-08-10T09:00:00Z", floor: Number.NaN, volume: 1 }];
  const png = renderFloorChart({ collectionName: "Dirty", currency: "ETH", samples: dirty, windowLabel: "past 24h" });
  assert.ok(png);
});
