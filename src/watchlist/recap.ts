import type { FloorSample } from "./historyStore.js";

/** Per-collection counters accumulated over one recap window (reset after each recap posts). */
export interface RecapCounters {
  listings: number;
  sales: number;
  leads: number;
  /** Summed native sale value observed in the window — a rough activity gauge, not OpenSea's official volume stat. */
  salesVolumeNative: number;
}

export interface RecapCollectionLine {
  collectionId: string;
  label: string;
  currency: string;
  floorNow: number | null;
  floorThen: number | null;
  /** Percent change across the window, or null when there isn't a start AND end sample to compare. */
  changePct: number | null;
  listings: number;
  sales: number;
  leads: number;
  salesVolumeNative: number;
}

export interface RecapSummary {
  generatedAt: string;
  windowHours: number;
  lines: RecapCollectionLine[];
  totals: RecapCounters;
  /** Biggest floor gainer/loser across the window, when at least one collection had a computable change. */
  topGainer: RecapCollectionLine | null;
  topLoser: RecapCollectionLine | null;
  ethUsdRate?: number;
}

export interface RecapInput {
  collectionId: string;
  label: string;
  currency: string;
  samples: FloorSample[];
  counters: RecapCounters;
}

export function emptyCounters(): RecapCounters {
  return { listings: 0, sales: 0, leads: 0, salesVolumeNative: 0 };
}

/**
 * Builds the once-daily overnight recap from each allowlisted collection's
 * retained floor samples plus the counters accumulated since the previous
 * recap. Pure — no I/O, no clock reads beyond the injected `now` — so the
 * summary logic is unit-testable without a live poll loop.
 *
 * A collection with fewer than two samples in the window yields a null
 * `changePct` rather than a fabricated 0%: "we don't have enough history to
 * say" and "it didn't move" are genuinely different, and the embed renders
 * them differently.
 */
export function buildRecapSummary(inputs: RecapInput[], windowHours: number, now: Date = new Date(), ethUsdRate?: number): RecapSummary {
  const lines: RecapCollectionLine[] = inputs.map((input) => {
    const samples = input.samples;
    const first = samples[0];
    const last = samples[samples.length - 1];

    const floorThen = first ? first.floor : null;
    const floorNow = last ? last.floor : null;
    const changePct =
      samples.length >= 2 && floorThen !== null && floorNow !== null && floorThen > 0
        ? Number((((floorNow - floorThen) / floorThen) * 100).toFixed(2))
        : null;

    return {
      collectionId: input.collectionId,
      label: input.label,
      currency: input.currency,
      floorNow,
      floorThen,
      changePct,
      listings: input.counters.listings,
      sales: input.counters.sales,
      leads: input.counters.leads,
      salesVolumeNative: Number(input.counters.salesVolumeNative.toFixed(4)),
    };
  });

  const totals = lines.reduce<RecapCounters>((acc, line) => {
    acc.listings += line.listings;
    acc.sales += line.sales;
    acc.leads += line.leads;
    acc.salesVolumeNative = Number((acc.salesVolumeNative + line.salesVolumeNative).toFixed(4));
    return acc;
  }, emptyCounters());

  const movable = lines.filter((l): l is RecapCollectionLine & { changePct: number } => l.changePct !== null);
  const topGainer = movable.length > 0 ? movable.reduce((best, l) => (l.changePct > best.changePct ? l : best)) : null;
  const topLoser = movable.length > 0 ? movable.reduce((worst, l) => (l.changePct < worst.changePct ? l : worst)) : null;

  return {
    generatedAt: now.toISOString(),
    windowHours,
    lines,
    totals,
    // A single collection that only moved up is a gainer, not also a
    // "loser" — only report the downside slot when something actually fell.
    topGainer: topGainer && topGainer.changePct > 0 ? topGainer : null,
    topLoser: topLoser && topLoser.changePct < 0 ? topLoser : null,
    ethUsdRate,
  };
}
