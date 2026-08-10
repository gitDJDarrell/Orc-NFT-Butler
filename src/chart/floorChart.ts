import type { FloorSample } from "../watchlist/historyStore.js";
import { Canvas, rgb } from "./canvas.js";

/**
 * Renders the floor/volume chart attached to the twice-daily trend digest
 * and the once-daily recap. Pure computation + rasterization: no I/O, no
 * network, no native dependencies (see png.ts).
 */

const WIDTH = 900;
const HEIGHT = 420;

const PAD_LEFT = 74;
const PAD_RIGHT = 22;
const PAD_TOP = 52;
const PAD_BOTTOM = 46;

// Discord dark-theme friendly palette.
const BG = rgb(0x2b2d31);
const PANEL = rgb(0x1e1f22);
const GRID = rgb(0x3f4147);
const AXIS = rgb(0x6d6f78);
const TEXT = rgb(0xdbdee1);
const TEXT_DIM = rgb(0x949ba4);
const FLOOR_UP = rgb(0x57f287);
const FLOOR_DOWN = rgb(0xed4245);
const FLOOR_FLAT = rgb(0x5865f2);
const VOLUME_BAR = rgb(0x4e5058);

export interface FloorChartOptions {
  collectionName: string;
  currency: string;
  samples: FloorSample[];
  /** Window label rendered in the subtitle, e.g. "past 24h". */
  windowLabel: string;
}

/** Compact axis label: 4 significant-ish digits without exponent noise. */
function formatTick(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(value).toLocaleString("en-US");
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01) return value.toFixed(3);
  return value.toFixed(4);
}

/** "14:00" in local time — the x-axis is short enough that the date is noise. */
function formatTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Renders the chart to PNG bytes, or returns null when there isn't enough
 * history to plot a line (fewer than 2 samples). Callers treat null as
 * "post the digest without an image" rather than an error — a brand-new
 * collection legitimately has no history yet.
 */
export function renderFloorChart(options: FloorChartOptions): Buffer | null {
  const samples = options.samples.filter((s) => Number.isFinite(s.floor));
  if (samples.length < 2) return null;

  const canvas = new Canvas(WIDTH, HEIGHT, BG);

  const plotX0 = PAD_LEFT;
  const plotY0 = PAD_TOP;
  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const plotX1 = plotX0 + plotW;
  const plotY1 = plotY0 + plotH;

  canvas.fillRect(plotX0, plotY0, plotW, plotH, PANEL);

  const floors = samples.map((s) => s.floor);
  let min = Math.min(...floors);
  let max = Math.max(...floors);
  if (min === max) {
    // A perfectly flat series would otherwise divide by zero — give it a
    // small symmetric band so the line renders through the middle.
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.05 : 1;
    min -= pad;
    max += pad;
  } else {
    const headroom = (max - min) * 0.12;
    min -= headroom;
    max += headroom;
  }

  const xFor = (index: number) => plotX0 + (index / (samples.length - 1)) * plotW;
  const yFor = (value: number) => plotY1 - ((value - min) / (max - min)) * plotH;

  // --- Volume bars (background layer, own scale) ---
  const volumes = samples.map((s) => (Number.isFinite(s.volume) ? (s.volume as number) : 0));
  const maxVolume = Math.max(...volumes);
  if (maxVolume > 0) {
    const barW = Math.max(1, Math.floor(plotW / samples.length) - 1);
    for (let i = 0; i < samples.length; i++) {
      const v = volumes[i]!;
      if (v <= 0) continue;
      const barH = (v / maxVolume) * (plotH * 0.28);
      canvas.fillRect(xFor(i) - barW / 2, plotY1 - barH, barW, barH, VOLUME_BAR);
    }
  }

  // --- Horizontal gridlines + y-axis labels ---
  const TICKS = 4;
  for (let i = 0; i <= TICKS; i++) {
    const value = min + ((max - min) * i) / TICKS;
    const y = yFor(value);
    canvas.dottedHLine(plotX0, plotX1, y, GRID);
    const label = formatTick(value);
    canvas.text(plotX0 - 8 - Canvas.textWidth(label), y - 3, label, TEXT_DIM);
  }

  // --- Axes ---
  canvas.line(plotX0, plotY0, plotX0, plotY1, AXIS);
  canvas.line(plotX0, plotY1, plotX1, plotY1, AXIS);

  // --- Floor line, colored by net direction over the window ---
  const first = floors[0]!;
  const last = floors[floors.length - 1]!;
  const lineColor = last > first ? FLOOR_UP : last < first ? FLOOR_DOWN : FLOOR_FLAT;

  for (let i = 1; i < samples.length; i++) {
    canvas.line(xFor(i - 1), yFor(floors[i - 1]!), xFor(i), yFor(floors[i]!), lineColor, 2);
  }
  // Emphasize the most recent reading.
  canvas.fillRect(xFor(samples.length - 1) - 3, yFor(last) - 3, 6, 6, lineColor);

  // --- X-axis time labels (first, middle, last) ---
  const labelIndices = samples.length >= 3 ? [0, Math.floor((samples.length - 1) / 2), samples.length - 1] : [0, samples.length - 1];
  for (const i of labelIndices) {
    const label = formatTimeLabel(samples[i]!.t);
    if (!label) continue;
    const w = Canvas.textWidth(label);
    // Keep the end labels inside the plot rather than bleeding off the edge.
    const x = Math.min(Math.max(xFor(i) - w / 2, plotX0), plotX1 - w);
    canvas.text(x, plotY1 + 10, label, TEXT_DIM);
  }

  // --- Titles ---
  const changePct = first > 0 ? ((last - first) / first) * 100 : 0;
  const arrow = last > first ? "+" : last < first ? "-" : "";
  const title = `${options.collectionName}`.slice(0, 52);
  canvas.text(PAD_LEFT, 14, title, TEXT, 2);

  const subtitle = `floor ${options.windowLabel}  ${formatTick(first)} -> ${formatTick(last)} ${options.currency}  (${arrow}${Math.abs(changePct).toFixed(1)}%)`;
  canvas.text(PAD_LEFT, 34, subtitle.slice(0, 90), TEXT_DIM);

  // --- Legend ---
  const legendY = HEIGHT - 16;
  canvas.fillRect(PAD_LEFT, legendY + 2, 10, 3, lineColor);
  canvas.text(PAD_LEFT + 15, legendY, `floor (${options.currency})`, TEXT_DIM);
  if (maxVolume > 0) {
    const volX = PAD_LEFT + 15 + Canvas.textWidth(`floor (${options.currency})`) + 18;
    canvas.fillRect(volX, legendY, 8, 7, VOLUME_BAR);
    canvas.text(volX + 13, legendY, `24h volume (peak ${formatTick(maxVolume)})`, TEXT_DIM);
  }

  return canvas.toPng();
}
