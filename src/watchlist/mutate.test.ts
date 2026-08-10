import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedCollection } from "../opensea/client.js";
import type { CollectionInfo } from "../types/index.js";
import { buildDefaultEntry, buildLeadRuleEntry, findMatchingEntry, planAddEntry, planCreateLeadRule, planRemoveEntry, validateLeadRuleParams } from "./mutate.js";
import type { AllowlistConfig, AllowlistEntry } from "./schema.js";

function makeResolved(overrides: Partial<ResolvedCollection> = {}): ResolvedCollection {
  return {
    address: "0xabc0000000000000000000000000000000abc0",
    slug: "test-collection",
    name: "Test Collection",
    ...overrides,
  };
}

function makeFloor(overrides: Partial<CollectionInfo> = {}): CollectionInfo {
  return {
    id: "0xabc0000000000000000000000000000000abc0",
    name: "Test Collection",
    floorPriceNative: 0.5,
    floorPriceCurrency: "ETH",
    chain: "ethereum",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    id: "existing-watch",
    label: "Existing Collection",
    enabled: true,
    priorityTier: "watch",
    collection: "0xexisting000000000000000000000000000000",
    filters: {},
    muted: false,
    dedupeWindowMinutes: 30,
    rateLimitPerHour: 10,
    ...overrides,
  };
}

test("buildDefaultEntry: scales priceBand/target off the live floor", () => {
  const entry = buildDefaultEntry(makeResolved(), makeFloor({ floorPriceNative: 2 }), []);
  assert.equal(entry.enabled, true);
  assert.equal(entry.priorityTier, "watch");
  assert.equal(entry.collection, "0xabc0000000000000000000000000000000abc0");
  assert.equal(entry.filters.priceBand?.maxFloor, 10); // 2 * 5
  assert.ok(entry.filters.priceBand!.targetBuyPrice! > 2); // 2 * 1.1
  assert.equal(entry.filters.trend?.minFloorMovePercent, 5);
});

test("buildDefaultEntry: falls back to a placeholder floor when none is available", () => {
  const entry = buildDefaultEntry(makeResolved(), null, []);
  assert.ok(entry.filters.priceBand!.maxFloor! > 0);
});

test("buildDefaultEntry: includes a liquidity gate only when owners data is available", () => {
  const withOwners = buildDefaultEntry(makeResolved(), makeFloor({ owners: 1000 }), []);
  assert.ok(withOwners.filters.liquidity?.minOwners);

  const withoutOwners = buildDefaultEntry(makeResolved(), makeFloor({ owners: undefined }), []);
  assert.equal(withoutOwners.filters.liquidity, undefined);
});

test("buildDefaultEntry: generates a unique id when the base id is taken", () => {
  const first = buildDefaultEntry(makeResolved({ name: "Azuki" }), null, []);
  const second = buildDefaultEntry(makeResolved({ name: "Azuki" }), null, [first.id]);
  assert.notEqual(first.id, second.id);
});

test("planAddEntry: appends a new entry to the config", () => {
  const cfg: AllowlistConfig = { entries: [makeEntry()] };
  const result = planAddEntry(cfg, makeResolved(), makeFloor());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.entries.length, 2);
    assert.equal(result.entry.collection, "0xabc0000000000000000000000000000000abc0");
  }
});

test("planAddEntry: rejects a collection that's already on the watchlist (case-insensitive address match)", () => {
  const cfg: AllowlistConfig = {
    entries: [makeEntry({ collection: "0xABC0000000000000000000000000000000ABC0", label: "Already Here" })],
  };
  const result = planAddEntry(cfg, makeResolved(), makeFloor());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /already on the watchlist/);
    assert.match(result.message, /Already Here/);
  }
});

test("findMatchingEntry: matches by exact address, resolved address, id, or label substring", () => {
  const cfg: AllowlistConfig = { entries: [makeEntry({ id: "azuki-watch", label: "Azuki (fun collection)", collection: "0xaddr1" })] };

  assert.equal(findMatchingEntry(cfg, "0xaddr1", null)?.id, "azuki-watch");
  assert.equal(findMatchingEntry(cfg, "something-else", "0xAddr1")?.id, "azuki-watch");
  assert.equal(findMatchingEntry(cfg, "azuki-watch", null)?.id, "azuki-watch");
  assert.equal(findMatchingEntry(cfg, "azuki", null)?.id, "azuki-watch");
  assert.equal(findMatchingEntry(cfg, "totally-unrelated", null), undefined);
});

test("planRemoveEntry: removes the matched entry and reports it", () => {
  const cfg: AllowlistConfig = { entries: [makeEntry({ id: "a" }), makeEntry({ id: "b", collection: "0xbbb", label: "Second" })] };
  const result = planRemoveEntry(cfg, "Second", null);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.entries.length, 1);
    assert.equal(result.config.entries[0]!.id, "a");
    assert.equal(result.removed.id, "b");
  }
});

test("planRemoveEntry: reports failure when nothing matches, without touching the config", () => {
  const cfg: AllowlistConfig = { entries: [makeEntry()] };
  const result = planRemoveEntry(cfg, "does-not-exist", null);
  assert.equal(result.ok, false);
});

test("validateLeadRuleParams: price_below requires a positive price", () => {
  assert.equal(validateLeadRuleParams({ condition: "price_below" }), "Condition `price_below` requires a positive `price` (in ETH).");
  assert.equal(validateLeadRuleParams({ condition: "price_below", price: 0 }) !== null, true);
  assert.equal(validateLeadRuleParams({ condition: "price_below", price: -1 }) !== null, true);
  assert.equal(validateLeadRuleParams({ condition: "price_below", price: 0.5 }), null);
});

test("validateLeadRuleParams: rarity_top_percent requires a 0-100 percentile", () => {
  assert.equal(validateLeadRuleParams({ condition: "rarity_top_percent" }) !== null, true);
  assert.equal(validateLeadRuleParams({ condition: "rarity_top_percent", percentile: 0 }) !== null, true);
  assert.equal(validateLeadRuleParams({ condition: "rarity_top_percent", percentile: 101 }) !== null, true);
  assert.equal(validateLeadRuleParams({ condition: "rarity_top_percent", percentile: 5 }), null);
});

test("validateLeadRuleParams: trait_listed and trait_floor both require a trait", () => {
  assert.equal(validateLeadRuleParams({ condition: "trait_listed" }) !== null, true);
  assert.equal(validateLeadRuleParams({ condition: "trait_floor" }) !== null, true);
  const trait = { key: "Background", value: "Blue" };
  assert.equal(validateLeadRuleParams({ condition: "trait_listed", trait }), null);
  assert.equal(validateLeadRuleParams({ condition: "trait_floor", trait }), null);
});

test("buildLeadRuleEntry: price_below sets only priceBand.targetBuyPrice, no other default filters", () => {
  const entry = buildLeadRuleEntry(makeResolved(), { condition: "price_below", price: 0.3 }, []);
  assert.equal(entry.filters.priceBand?.targetBuyPrice, 0.3);
  assert.equal(entry.filters.priceBand?.maxFloor, undefined);
  assert.equal(entry.filters.bidSpread, undefined);
  assert.equal(entry.filters.trend, undefined);
  assert.equal(entry.traits, undefined);
  assert.match(entry.label, /price below 0\.3 ETH/);
});

test("buildLeadRuleEntry: rarity_top_percent sets only rarity.maxTopPercentile", () => {
  const entry = buildLeadRuleEntry(makeResolved(), { condition: "rarity_top_percent", percentile: 5 }, []);
  assert.equal(entry.filters.rarity?.maxTopPercentile, 5);
  assert.equal(entry.filters.priceBand, undefined);
  assert.match(entry.label, /top 5% rarity/);
});

test("buildLeadRuleEntry: trait_listed sets entry.traits, not a filters.traitFloor", () => {
  const trait = { key: "Background", value: "Blue" };
  const entry = buildLeadRuleEntry(makeResolved(), { condition: "trait_listed", trait }, []);
  assert.deepEqual(entry.traits, [trait]);
  assert.equal(entry.filters.traitFloor, undefined);
  assert.match(entry.label, /trait Background=Blue listed/);
});

test("buildLeadRuleEntry: trait_floor sets filters.traitFloor with an optional price cap", () => {
  const trait = { key: "Background", value: "Blue" };
  const withPrice = buildLeadRuleEntry(makeResolved(), { condition: "trait_floor", trait, price: 2 }, []);
  assert.deepEqual(withPrice.filters.traitFloor, { trait, maxPrice: 2 });

  const withoutPrice = buildLeadRuleEntry(makeResolved(), { condition: "trait_floor", trait }, []);
  assert.deepEqual(withoutPrice.filters.traitFloor, { trait });
});

test("buildLeadRuleEntry: generates a unique id even across repeated condition types for the same collection", () => {
  const first = buildLeadRuleEntry(makeResolved(), { condition: "price_below", price: 0.3 }, []);
  const second = buildLeadRuleEntry(makeResolved(), { condition: "price_below", price: 0.5 }, [first.id]);
  assert.notEqual(first.id, second.id);
});

test("planCreateLeadRule: rejects invalid params without touching the config", () => {
  const cfg: AllowlistConfig = { entries: [] };
  const result = planCreateLeadRule(cfg, makeResolved(), { condition: "price_below" });
  assert.equal(result.ok, false);
});

test("planCreateLeadRule: appends the new rule, allowing multiple rules for the same collection", () => {
  let cfg: AllowlistConfig = { entries: [] };
  const first = planCreateLeadRule(cfg, makeResolved(), { condition: "price_below", price: 0.3 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  cfg = first.config;

  const second = planCreateLeadRule(cfg, makeResolved(), { condition: "rarity_top_percent", percentile: 5 });
  assert.equal(second.ok, true);
  if (!second.ok) return;

  assert.equal(second.config.entries.length, 2);
  assert.equal(second.config.entries.every((e) => e.collection === makeResolved().address), true);
});
