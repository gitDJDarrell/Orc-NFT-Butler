import assert from "node:assert/strict";
import { test } from "node:test";
import type { BidLeadCandidate } from "./candidate.js";
import { evaluateCandidate } from "./evaluate.js";
import { LeadLimiter } from "./limiter.js";
import type { AllowlistConfig, AllowlistEntry } from "./schema.js";

function makeEntry(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    id: "entry-1",
    label: "Test entry",
    enabled: true,
    priorityTier: "watch",
    collection: "0xcollection",
    filters: {},
    muted: false,
    dedupeWindowMinutes: 30,
    rateLimitPerHour: 10,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<BidLeadCandidate> = {}): BidLeadCandidate {
  return {
    collectionId: "0xcollection",
    collectionName: "Test Collection",
    tokenId: "42",
    priceNative: 1,
    priceCurrency: "ETH",
    floorPriceNative: 1,
    percentFromFloor: 0,
    source: "opensea",
    listingId: "listing-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

test("evaluateCandidate: allowlist-only — no entry for the collection means no match, ever", () => {
  const config: AllowlistConfig = { entries: [makeEntry({ collection: "0xsomethingelse" })] };
  const candidate = makeCandidate({ collectionId: "0xcollection" });
  const match = evaluateCandidate(candidate, config, new LeadLimiter());
  assert.equal(match, null);
});

test("evaluateCandidate: disabled entries never match even if collection matches", () => {
  const config: AllowlistConfig = { entries: [makeEntry({ enabled: false })] };
  const match = evaluateCandidate(makeCandidate(), config, new LeadLimiter());
  assert.equal(match, null);
});

test("evaluateCandidate: priceBand.targetBuyPrice gates on candidate price", () => {
  const config: AllowlistConfig = {
    entries: [makeEntry({ filters: { priceBand: { targetBuyPrice: 2 } } })],
  };
  const limiter = new LeadLimiter();

  const tooExpensive = evaluateCandidate(makeCandidate({ priceNative: 3, tokenId: "1" }), config, limiter);
  assert.equal(tooExpensive, null);

  const withinBudget = evaluateCandidate(makeCandidate({ priceNative: 1.5, tokenId: "2" }), config, limiter);
  assert.ok(withinBudget);
  assert.equal(withinBudget?.entry.id, "entry-1");
});

test("evaluateCandidate: rarity filter fails closed when rank data is missing", () => {
  const config: AllowlistConfig = {
    entries: [makeEntry({ filters: { rarity: { maxTopPercentile: 5 } } })],
  };
  const noRankData = evaluateCandidate(makeCandidate({ rankPercentile: undefined }), config, new LeadLimiter());
  assert.equal(noRankData, null, "missing rarity data must not silently pass a rarity filter");

  const rareEnough = evaluateCandidate(makeCandidate({ rankPercentile: 3, tokenId: "rare" }), config, new LeadLimiter());
  assert.ok(rareEnough);

  const notRareEnough = evaluateCandidate(makeCandidate({ rankPercentile: 50, tokenId: "common" }), config, new LeadLimiter());
  assert.equal(notRareEnough, null);
});

test("evaluateCandidate: traitFloor requires the specific trait and a price cap", () => {
  const config: AllowlistConfig = {
    entries: [
      makeEntry({
        filters: { traitFloor: { trait: { key: "Headwear", value: "Crown" }, maxPrice: 5 } },
      }),
    ],
  };
  const limiter = new LeadLimiter();

  const wrongTrait = evaluateCandidate(
    makeCandidate({ trait: { key: "Headwear", value: "Cap" }, priceNative: 1, tokenId: "1" }),
    config,
    limiter,
  );
  assert.equal(wrongTrait, null);

  const rightTraitTooExpensive = evaluateCandidate(
    makeCandidate({ trait: { key: "Headwear", value: "Crown" }, priceNative: 10, tokenId: "2" }),
    config,
    limiter,
  );
  assert.equal(rightTraitTooExpensive, null);

  const match = evaluateCandidate(
    makeCandidate({ trait: { key: "Headwear", value: "Crown" }, priceNative: 4, tokenId: "3" }),
    config,
    limiter,
  );
  assert.ok(match);
});

test("evaluateCandidate: traitFloor matches against the full traits[] list (live-data shape), not just the single highlighted trait", () => {
  const config: AllowlistConfig = {
    entries: [
      makeEntry({
        filters: { traitFloor: { trait: { key: "Eyes", value: "Laser" }, maxPrice: 5 } },
      }),
    ],
  };
  const limiter = new LeadLimiter();

  // No `trait` field at all — only the plural `traits` list, as a live NFT-detail fetch would populate.
  const match = evaluateCandidate(
    makeCandidate({
      trait: undefined,
      traits: [
        { key: "Background", value: "Blue" },
        { key: "Eyes", value: "Laser" },
        { key: "Fur", value: "Golden" },
      ],
      priceNative: 2,
      tokenId: "1",
    }),
    config,
    limiter,
  );
  assert.ok(match);

  const noMatch = evaluateCandidate(
    makeCandidate({
      trait: undefined,
      traits: [
        { key: "Background", value: "Blue" },
        { key: "Fur", value: "Golden" },
      ],
      priceNative: 2,
      tokenId: "2",
    }),
    config,
    limiter,
  );
  assert.equal(noMatch, null);
});

test("evaluateCandidate: entry.traits matches against the full traits[] list", () => {
  const config: AllowlistConfig = {
    entries: [makeEntry({ traits: [{ key: "Fur", value: "Golden" }] })],
  };
  const limiter = new LeadLimiter();

  const match = evaluateCandidate(
    makeCandidate({
      trait: undefined,
      traits: [
        { key: "Background", value: "Blue" },
        { key: "Fur", value: "Golden" },
      ],
      tokenId: "1",
    }),
    config,
    limiter,
  );
  assert.ok(match);
  assert.match(match!.reasoning.join(" "), /Fur: Golden/);
});

test("evaluateCandidate: bidSpread bounds percentFromFloor", () => {
  const config: AllowlistConfig = {
    entries: [makeEntry({ filters: { bidSpread: { minPercentFromFloor: -20, maxPercentFromFloor: 0 } } })],
  };
  const limiter = new LeadLimiter();

  const belowRange = evaluateCandidate(makeCandidate({ percentFromFloor: -30, tokenId: "1" }), config, limiter);
  assert.equal(belowRange, null);

  const aboveRange = evaluateCandidate(makeCandidate({ percentFromFloor: 5, tokenId: "2" }), config, limiter);
  assert.equal(aboveRange, null);

  const inRange = evaluateCandidate(makeCandidate({ percentFromFloor: -10, tokenId: "3" }), config, limiter);
  assert.ok(inRange);
});

test("evaluateCandidate: liquidity gates require minimum volume/owners/listings", () => {
  const config: AllowlistConfig = {
    entries: [makeEntry({ filters: { liquidity: { minVolume24hNative: 10, minOwners: 100 } } })],
  };
  const limiter = new LeadLimiter();

  const illiquid = evaluateCandidate(
    makeCandidate({ volume24hNative: 1, owners: 5, tokenId: "1" }),
    config,
    limiter,
  );
  assert.equal(illiquid, null);

  const liquid = evaluateCandidate(
    makeCandidate({ volume24hNative: 20, owners: 500, tokenId: "2" }),
    config,
    limiter,
  );
  assert.ok(liquid);
});

test("evaluateCandidate: trend trigger requires floor move and/or listing spike thresholds", () => {
  const config: AllowlistConfig = {
    entries: [makeEntry({ filters: { trend: { minFloorMovePercent: 5, minListingSpikeCount: 3 } } })],
  };
  const limiter = new LeadLimiter();

  const noTrend = evaluateCandidate(
    makeCandidate({ floorMovePercent: 1, listingSpikeCount: 1, tokenId: "1" }),
    config,
    limiter,
  );
  assert.equal(noTrend, null);

  const trending = evaluateCandidate(
    makeCandidate({ floorMovePercent: -8, listingSpikeCount: 4, tokenId: "2" }),
    config,
    limiter,
  );
  assert.ok(trending);
});

test("evaluateCandidate: ownerWallets scoping only matches configured sellers", () => {
  const config: AllowlistConfig = {
    entries: [makeEntry({ ownerWallets: ["0xWHALE"] })],
  };
  const limiter = new LeadLimiter();

  const notWhale = evaluateCandidate(makeCandidate({ sellerWallet: "0xsomeoneelse", tokenId: "1" }), config, limiter);
  assert.equal(notWhale, null);

  const whale = evaluateCandidate(makeCandidate({ sellerWallet: "0xwhale", tokenId: "2" }), config, limiter);
  assert.ok(whale, "wallet comparison should be case-insensitive");
});

test("evaluateCandidate: a suppressed (deduped) match returns null even though it otherwise matches", () => {
  const config: AllowlistConfig = { entries: [makeEntry({ dedupeWindowMinutes: 60 })] };
  const limiter = new LeadLimiter();
  const now = new Date("2026-01-01T00:00:00Z");

  const first = evaluateCandidate(makeCandidate({ tokenId: "1" }), config, limiter, now);
  assert.ok(first);

  const soonAfter = new Date(now.getTime() + 5 * 60_000);
  const second = evaluateCandidate(makeCandidate({ tokenId: "1" }), config, limiter, soonAfter);
  assert.equal(second, null, "same token within the dedupe window should be suppressed");
});
