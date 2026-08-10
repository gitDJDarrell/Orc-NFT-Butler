import { z } from "zod";

/**
 * Zod schema for the allowlist-only watchlist config (watchlist.json) that
 * drives the Discord bid-lead pipeline. This is deliberately separate from
 * the simpler dashboard watchlist (src/monitor/index.ts, WatchlistEntry in
 * src/types/index.ts) — this one is allowlist-only: a collection (and
 * optionally specific tokens/traits/wallets within it) only ever produces a
 * bid lead if it appears here, and only once it passes every filter defined
 * on its entry.
 */

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const traitSchema = z
  .object({
    key: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

export const priceBandFilterSchema = z
  .object({
    minFloor: z.number().nonnegative().optional(),
    maxFloor: z.number().nonnegative().optional(),
    targetBuyPrice: z.number().nonnegative().optional(),
  })
  .strict();

export const rarityFilterSchema = z
  .object({
    /** Absolute rank cutoff — only fire for tokens ranked at or better than this (lower rank = rarer). */
    maxRank: z.number().int().positive().optional(),
    /** Top-N% cutoff, e.g. 5 = top 5% rarest. */
    maxTopPercentile: z.number().min(0).max(100).optional(),
  })
  .strict();

export const traitFloorFilterSchema = z
  .object({
    trait: traitSchema,
    minPrice: z.number().nonnegative().optional(),
    maxPrice: z.number().nonnegative().optional(),
  })
  .strict();

export const bidSpreadFilterSchema = z
  .object({
    /** Percent difference from current floor: ((price - floor) / floor) * 100. Negative = below floor (a good buy). */
    minPercentFromFloor: z.number().optional(),
    maxPercentFromFloor: z.number().optional(),
  })
  .strict();

export const liquidityFilterSchema = z
  .object({
    minVolume24hNative: z.number().nonnegative().optional(),
    minOwners: z.number().int().nonnegative().optional(),
    minListingsCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const trendFilterSchema = z
  .object({
    minFloorMovePercent: z.number().nonnegative().optional(),
    minListingSpikeCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const walletActivityFilterSchema = z
  .object({
    minWhaleValueNative: z.number().nonnegative().optional(),
  })
  .strict();

export const watchlistFiltersSchema = z
  .object({
    priceBand: priceBandFilterSchema.optional(),
    rarity: rarityFilterSchema.optional(),
    traitFloor: traitFloorFilterSchema.optional(),
    bidSpread: bidSpreadFilterSchema.optional(),
    liquidity: liquidityFilterSchema.optional(),
    trend: trendFilterSchema.optional(),
    walletActivity: walletActivityFilterSchema.optional(),
  })
  .strict();

export const quietHoursSchema = z
  .object({
    /** 24h "HH:MM", local to `timezone`. */
    start: z.string().regex(HH_MM, "expected 24h HH:MM"),
    end: z.string().regex(HH_MM, "expected 24h HH:MM"),
    /** IANA timezone name, e.g. "America/New_York". Defaults to UTC. */
    timezone: z.string().default("UTC"),
  })
  .strict();

export const allowlistEntrySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean().default(true),
    priorityTier: z.enum(["blue-chip", "watch"]).default("watch"),
    /** EVM contract address for the collection. Required — this is the allowlist key. */
    collection: z.string().min(1),
    /** If set, only these token IDs within the collection are eligible. Omit to allow any token. */
    tokenIds: z.array(z.string()).optional(),
    /** If set, a listing must carry one of these traits to be eligible. */
    traits: z.array(traitSchema).optional(),
    /** If set, only leads from these seller/owner wallets are eligible. */
    ownerWallets: z.array(z.string()).optional(),
    filters: watchlistFiltersSchema.default({}),
    quietHours: quietHoursSchema.optional(),
    muted: z.boolean().default(false),
    /** Suppress repeat leads for the same token within this many minutes. */
    dedupeWindowMinutes: z.number().nonnegative().default(30),
    /** Max leads this entry may fire in any rolling 60 minutes. */
    rateLimitPerHour: z.number().positive().default(10),
  })
  .strict();

/**
 * Global tunables editable from Discord via `/config set` (Group 3.4).
 * Every field is optional: an absent field means "fall back to the .env
 * value", so watchlist.json stays a pure override layer and deleting a key
 * restores the environment default (see src/config/runtime.ts).
 */
export const globalSettingsSchema = z
  .object({
    /** Overrides SHOW_USD. */
    showUsd: z.boolean().optional(),
    /** Overrides FLOOR_MOVE_THRESHOLD, expressed as a PERCENT (5 = 5%) rather than .env's fraction — percent is what the operator types in Discord. */
    floorMoveThresholdPercent: z.number().positive().max(100).optional(),
    /** Overrides NEW_LISTING_MAX_PRICE (native units, e.g. ETH). */
    newListingMaxPrice: z.number().nonnegative().optional(),
    /** Overrides OFFER_ABOVE_COLLECTION_THRESHOLD_PERCENT. */
    offerAboveCollectionThresholdPercent: z.number().nonnegative().max(1000).optional(),
    /** Overrides TREND_ALERT_TIMES, e.g. "08:00,20:00". */
    trendAlertTimes: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d(,([01]\d|2[0-3]):[0-5]\d)*$/, "expected comma-separated 24h HH:MM times")
      .optional(),
    /** Overrides DAILY_RECAP_TIME, e.g. "07:00". */
    dailyRecapTime: z.string().regex(HH_MM, "expected 24h HH:MM").optional(),
  })
  .strict();

export const allowlistConfigSchema = z
  .object({
    entries: z.array(allowlistEntrySchema),
    settings: globalSettingsSchema.optional(),
  })
  .strict();

// Note: traitSchema's inferred shape is structurally identical to the
// shared `Trait` type in src/types/index.ts; import that one rather than
// re-exporting a duplicate here.
export type WatchlistFilters = z.infer<typeof watchlistFiltersSchema>;
export type QuietHours = z.infer<typeof quietHoursSchema>;
export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>;
export type AllowlistConfig = z.infer<typeof allowlistConfigSchema>;
export type GlobalSettings = z.infer<typeof globalSettingsSchema>;
