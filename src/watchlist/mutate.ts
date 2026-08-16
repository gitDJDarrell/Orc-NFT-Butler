import type { CollectionInfo, Trait, TraitCategory } from "../types/index.js";
import type { ResolvedCollection } from "../opensea/client.js";
import { allowlistEntrySchema, type AllowlistConfig, type AllowlistEntry, type WatchlistFilters } from "./schema.js";

/**
 * Pure functions for building /watchlist add|remove's effect on an
 * AllowlistConfig — no filesystem, no Discord, no network. Given a config
 * in, they return a new config out (or a rejection reason), so they're
 * directly unit-testable. The actual disk write (saveWatchlistConfig) and
 * live reload (BidLeadMonitor.reload()) happen in the caller
 * (src/discord-bot/client.ts), which is the only place that needs real I/O.
 */

const DEFAULT_TREND_THRESHOLD_PCT = 5;

function slugifyForId(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return slug || "collection";
}

function uniqueId(base: string, existingIds: readonly string[]): string {
  const first = `${base}-watch`;
  if (!existingIds.includes(first)) return first;
  let n = 2;
  while (existingIds.includes(`${first}-${n}`)) n++;
  return `${first}-${n}`;
}

/**
 * Sensible defaults for a freshly-added collection, informed by its current
 * floor (if we have one) — same pattern used for the example entries in
 * watchlist.json: a generous price ceiling, a target-buy near floor, a wide
 * bid-spread band appropriate for a newly-watched collection, a light
 * liquidity sanity check, and the project's default trend threshold.
 */
export function buildDefaultEntry(
  resolved: ResolvedCollection,
  floor: CollectionInfo | null,
  existingIds: readonly string[],
  trait?: Trait,
): AllowlistEntry {
  const floorPrice = floor?.floorPriceNative && floor.floorPriceNative > 0 ? floor.floorPriceNative : 0.1;

  // A trait scopes the entry via `traits`, which evaluate.ts already
  // enforces: a candidate only matches if its trait set contains one of
  // these. The generic price/spread/liquidity/trend defaults are LAYERED on
  // top rather than replaced — /watchlist add still means "watch this
  // collection sensibly", with the trait narrowing WHICH items qualify.
  // (This is the opposite of /watchlist create-rule, which deliberately
  // builds a single-condition entry with no implied defaults.)
  return allowlistEntrySchema.parse({
    id: uniqueId(slugifyForId(`${resolved.name || resolved.slug || resolved.address}${trait ? `-${trait.key}-${trait.value}` : ""}`), existingIds),
    label: trait ? `${resolved.name} — ${trait.key}: ${trait.value}` : resolved.name,
    enabled: true,
    priorityTier: "watch",
    collection: resolved.address,
    ...(trait ? { traits: [trait] } : {}),
    filters: {
      priceBand: {
        maxFloor: Number((floorPrice * 5).toFixed(6)),
        targetBuyPrice: Number((floorPrice * 1.1).toFixed(6)),
      },
      bidSpread: { minPercentFromFloor: -30, maxPercentFromFloor: 10 },
      ...(floor?.owners ? { liquidity: { minOwners: Math.max(10, Math.floor(floor.owners * 0.25)) } } : {}),
      trend: { minFloorMovePercent: DEFAULT_TREND_THRESHOLD_PCT },
    },
    dedupeWindowMinutes: 30,
    rateLimitPerHour: 8,
  });
}

/** True when two optional trait scopes refer to the same trait (case-insensitive), including both being absent. */
function sameTraitScope(a: Trait | undefined, b: Trait | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.key.toLowerCase() === b.key.toLowerCase() && a.value.toLowerCase() === b.value.toLowerCase();
}

export type AddEntryResult =
  | { ok: true; config: AllowlistConfig; entry: AllowlistEntry }
  | { ok: false; message: string };

export function planAddEntry(
  cfg: AllowlistConfig,
  resolved: ResolvedCollection,
  floor: CollectionInfo | null,
  trait?: Trait,
): AddEntryResult {
  // Duplicate detection is scoped to the TRAIT, not just the collection:
  // adding the same collection twice for two different traits is a
  // legitimate thing to want (e.g. watch Blue backgrounds and Gold fur
  // separately), so only an identical collection+trait pairing is a
  // duplicate. Without the trait dimension this rejected every second add.
  const existing = cfg.entries.find(
    (e) => e.collection.toLowerCase() === resolved.address.toLowerCase() && sameTraitScope(e.traits?.[0], trait),
  );
  if (existing) {
    const scope = trait ? ` scoped to ${trait.key}: ${trait.value}` : "";
    return {
      ok: false,
      message: `${resolved.name}${scope} is already on the watchlist as "${existing.label}"${existing.enabled ? "" : " (currently disabled)"}.`,
    };
  }

  const entry = buildDefaultEntry(
    resolved,
    floor,
    cfg.entries.map((e) => e.id),
    trait,
  );
  return { ok: true, config: { entries: [...cfg.entries, entry] }, entry };
}

/**
 * Validates a requested trait against a collection's REAL trait catalog, so
 * a typo (or a hand-typed trait that doesn't exist) is rejected up front
 * rather than silently creating an entry that can never match anything.
 * Matching is case-insensitive; the returned trait uses the catalog's exact
 * casing so what gets stored matches what OpenSea reports on listings.
 */
export type TraitValidation = { ok: true; trait: Trait } | { ok: false; message: string };

export function validateTraitAgainstCatalog(catalog: readonly TraitCategory[], key: string, value: string): TraitValidation {
  if (catalog.length === 0) {
    return { ok: false, message: "Could not load this collection's trait catalog, so the trait can't be verified. Try again in a moment, or add it without a trait." };
  }

  const category = catalog.find((c) => c.key.toLowerCase() === key.trim().toLowerCase());
  if (!category) {
    const available = catalog
      .map((c) => `\`${c.key}\``)
      .slice(0, 15)
      .join(", ");
    return { ok: false, message: `\`${key}\` isn't a trait category for this collection. Available: ${available}${catalog.length > 15 ? ", …" : ""}` };
  }

  const matched = category.values.find((v) => v.toLowerCase() === value.trim().toLowerCase());
  if (!matched) {
    const available = category.values
      .map((v) => `\`${v}\``)
      .slice(0, 15)
      .join(", ");
    return {
      ok: false,
      message: `\`${value}\` isn't a value of \`${category.key}\` for this collection. Available: ${available}${category.values.length > 15 ? ", …" : ""}`,
    };
  }

  return { ok: true, trait: { key: category.key, value: matched } };
}

/** Matches /watchlist remove's input against an entry by address, id, or a label substring — in that order of preference. */
export function findMatchingEntry(cfg: AllowlistConfig, input: string, resolvedAddress: string | null): AllowlistEntry | undefined {
  const lowerInput = input.trim().toLowerCase();
  return (
    cfg.entries.find((e) => e.collection.toLowerCase() === lowerInput) ??
    (resolvedAddress ? cfg.entries.find((e) => e.collection.toLowerCase() === resolvedAddress.toLowerCase()) : undefined) ??
    cfg.entries.find((e) => e.id.toLowerCase() === lowerInput) ??
    cfg.entries.find((e) => e.label.toLowerCase().includes(lowerInput))
  );
}

export type RemoveEntryResult =
  | { ok: true; config: AllowlistConfig; removed: AllowlistEntry }
  | { ok: false; message: string };

export function planRemoveEntry(cfg: AllowlistConfig, input: string, resolvedAddress: string | null): RemoveEntryResult {
  const match = findMatchingEntry(cfg, input, resolvedAddress);
  if (!match) {
    return { ok: false, message: `No watchlist entry matches "${input}".` };
  }
  return { ok: true, config: { entries: cfg.entries.filter((e) => e.id !== match.id) }, removed: match };
}

/**
 * The condition types the guided /watchlist create-rule builder supports —
 * each maps to ONE existing filter/scope mechanism the evaluator already
 * enforces (see evaluate.ts):
 *   - price_below   -> filters.priceBand.targetBuyPrice
 *   - rarity_top_percent -> filters.rarity.maxTopPercentile
 *   - trait_listed  -> entry.traits (item carrying this trait gets listed)
 *   - trait_floor   -> filters.traitFloor (this trait, optionally price-capped)
 */
export type LeadRuleCondition = "price_below" | "rarity_top_percent" | "trait_listed" | "trait_floor";

export interface LeadRuleParams {
  condition: LeadRuleCondition;
  /** ETH ceiling — required for price_below; optional cap for trait_floor. */
  price?: number;
  /** 0-100 — required for rarity_top_percent. */
  percentile?: number;
  /** Required for trait_listed and trait_floor. */
  trait?: Trait;
}

/** Checks that the params a specific condition actually needs are present and sane. Returns a user-facing error, or null if valid. */
export function validateLeadRuleParams(params: LeadRuleParams): string | null {
  switch (params.condition) {
    case "price_below":
      if (params.price === undefined || params.price <= 0) {
        return "Condition `price_below` requires a positive `price` (in ETH).";
      }
      return null;
    case "rarity_top_percent":
      if (params.percentile === undefined || params.percentile <= 0 || params.percentile > 100) {
        return "Condition `rarity_top_percent` requires a `percentile` between 0 and 100.";
      }
      return null;
    case "trait_listed":
      if (!params.trait) {
        return "Condition `trait_listed` requires both `trait_category` and `trait_value`.";
      }
      return null;
    case "trait_floor":
      if (!params.trait) {
        return "Condition `trait_floor` requires both `trait_category` and `trait_value`.";
      }
      return null;
  }
}

function describeLeadRuleCondition(params: LeadRuleParams): string {
  switch (params.condition) {
    case "price_below":
      return `price below ${params.price} ETH`;
    case "rarity_top_percent":
      return `top ${params.percentile}% rarity`;
    case "trait_listed":
      return `trait ${params.trait!.key}=${params.trait!.value} listed`;
    case "trait_floor":
      return `trait floor ${params.trait!.key}=${params.trait!.value}${params.price !== undefined ? ` (≤${params.price} ETH)` : ""}`;
  }
}

/**
 * Builds a single-condition allowlist entry for the guided rule builder.
 * Deliberately does NOT layer on buildDefaultEntry's generic
 * maxFloor/bidSpread/trend defaults — a guided rule represents exactly the
 * one condition the user picked, nothing implied on top of it. Caller must
 * validate params first (validateLeadRuleParams) — this assumes they're valid.
 */
export function buildLeadRuleEntry(resolved: ResolvedCollection, params: LeadRuleParams, existingIds: readonly string[]): AllowlistEntry {
  const filters: WatchlistFilters = {};
  let traits: Trait[] | undefined;

  switch (params.condition) {
    case "price_below":
      filters.priceBand = { targetBuyPrice: params.price };
      break;
    case "rarity_top_percent":
      filters.rarity = { maxTopPercentile: params.percentile };
      break;
    case "trait_listed":
      traits = [params.trait!];
      break;
    case "trait_floor":
      filters.traitFloor = { trait: params.trait!, ...(params.price !== undefined ? { maxPrice: params.price } : {}) };
      break;
  }

  return allowlistEntrySchema.parse({
    id: uniqueId(slugifyForId(`${resolved.name || resolved.slug}-${params.condition}`), existingIds),
    label: `${resolved.name} — ${describeLeadRuleCondition(params)}`,
    enabled: true,
    priorityTier: "watch",
    collection: resolved.address,
    ...(traits ? { traits } : {}),
    filters,
    dedupeWindowMinutes: 30,
    rateLimitPerHour: 8,
  });
}

export type CreateLeadRuleResult = { ok: true; config: AllowlistConfig; entry: AllowlistEntry } | { ok: false; message: string };

/** Validates params, then appends a new lead-rule entry — collections can carry multiple rules (one per condition), so unlike planAddEntry there's no "already on the watchlist" rejection here. */
export function planCreateLeadRule(cfg: AllowlistConfig, resolved: ResolvedCollection, params: LeadRuleParams): CreateLeadRuleResult {
  const validationError = validateLeadRuleParams(params);
  if (validationError) return { ok: false, message: validationError };

  const entry = buildLeadRuleEntry(
    resolved,
    params,
    cfg.entries.map((e) => e.id),
  );
  return { ok: true, config: { entries: [...cfg.entries, entry] }, entry };
}
