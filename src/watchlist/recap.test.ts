import assert from "node:assert/strict";
import test from "node:test";
import type { FloorSample } from "./historyStore.js";
import { buildRecapSummary, emptyCounters, type RecapInput } from "./recap.js";

function samples(...floors: number[]): FloorSample[] {
  const base = Date.parse("2026-08-10T00:00:00Z");
  return floors.map((floor, i) => ({ t: new Date(base + i * 3_600_000).toISOString(), floor }));
}

function makeInput(overrides: Partial<RecapInput> = {}): RecapInput {
  return {
    collectionId: "0xabc",
    label: "Test Collection",
    currency: "ETH",
    samples: samples(1, 1.1),
    counters: emptyCounters(),
    ...overrides,
  };
}

const NOW = new Date("2026-08-10T07:00:00Z");

test("buildRecapSummary: computes percent change across the window", () => {
  const summary = buildRecapSummary([makeInput({ samples: samples(0.5, 0.6) })], 24, NOW);
  const line = summary.lines[0]!;

  assert.equal(line.floorThen, 0.5);
  assert.equal(line.floorNow, 0.6);
  assert.equal(line.changePct, 20);
});

test("buildRecapSummary: reports null change (not 0%) when there isn't enough history", () => {
  // "we can't say" and "it didn't move" are genuinely different, and the
  // embed renders them differently — a fabricated 0% would read as a fact.
  const oneSample = buildRecapSummary([makeInput({ samples: samples(0.5) })], 24, NOW);
  assert.equal(oneSample.lines[0]!.changePct, null);
  assert.equal(oneSample.lines[0]!.floorNow, 0.5);

  const noSamples = buildRecapSummary([makeInput({ samples: [] })], 24, NOW);
  assert.equal(noSamples.lines[0]!.changePct, null);
  assert.equal(noSamples.lines[0]!.floorNow, null);
});

test("buildRecapSummary: a genuinely flat floor is 0%, not null", () => {
  const summary = buildRecapSummary([makeInput({ samples: samples(0.5, 0.5) })], 24, NOW);
  assert.equal(summary.lines[0]!.changePct, 0);
});

test("buildRecapSummary: totals counters across every collection", () => {
  const summary = buildRecapSummary(
    [
      makeInput({ collectionId: "0xa", label: "A", counters: { listings: 3, sales: 1, leads: 2, salesVolumeNative: 1.5 } }),
      makeInput({ collectionId: "0xb", label: "B", counters: { listings: 4, sales: 2, leads: 0, salesVolumeNative: 2.25 } }),
    ],
    24,
    NOW,
  );

  assert.equal(summary.totals.listings, 7);
  assert.equal(summary.totals.sales, 3);
  assert.equal(summary.totals.leads, 2);
  assert.equal(summary.totals.salesVolumeNative, 3.75);
});

test("buildRecapSummary: picks the biggest gainer and loser", () => {
  const summary = buildRecapSummary(
    [
      makeInput({ collectionId: "0xa", label: "Up big", samples: samples(1, 1.5) }), // +50%
      makeInput({ collectionId: "0xb", label: "Up small", samples: samples(1, 1.1) }), // +10%
      makeInput({ collectionId: "0xc", label: "Down", samples: samples(1, 0.7) }), // -30%
    ],
    24,
    NOW,
  );

  assert.equal(summary.topGainer?.label, "Up big");
  assert.equal(summary.topLoser?.label, "Down");
});

test("buildRecapSummary: doesn't report a riser as also being the top loser", () => {
  // With one collection that only went up, the "loser" slot must stay empty
  // rather than reporting the same positive move as a decline.
  const summary = buildRecapSummary([makeInput({ samples: samples(1, 1.2) })], 24, NOW);
  assert.equal(summary.topGainer?.changePct, 20);
  assert.equal(summary.topLoser, null);
});

test("buildRecapSummary: no collection with computable change leaves both slots empty", () => {
  const summary = buildRecapSummary([makeInput({ samples: samples(1) })], 24, NOW);
  assert.equal(summary.topGainer, null);
  assert.equal(summary.topLoser, null);
});

test("buildRecapSummary: carries the window and generation time through", () => {
  const summary = buildRecapSummary([makeInput()], 24, NOW, 3000);
  assert.equal(summary.windowHours, 24);
  assert.equal(summary.generatedAt, NOW.toISOString());
  assert.equal(summary.ethUsdRate, 3000);
});
