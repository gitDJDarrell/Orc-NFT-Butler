import { config } from "./env.js";
import type { GlobalSettings } from "../watchlist/schema.js";

/**
 * The single resolution point for tunables that are editable BOTH in .env
 * and at runtime from Discord (`/config set`, Group 3.4).
 *
 * Precedence is always: watchlist.json `settings` override -> .env value.
 * An override that is absent (or cleared via `/config reset`) falls straight
 * back to the environment, so .env stays the source of truth for anything
 * the operator hasn't deliberately changed from Discord.
 *
 * Everything that reads a tunable goes through the getters here rather than
 * touching `config` directly, so a `/config set` takes effect immediately
 * across the whole process without a restart.
 */

let overrides: GlobalSettings = {};

/** Replaces the whole override set — called at startup and after every watchlist.json reload. */
export function applySettingsOverrides(settings: GlobalSettings | undefined): void {
  overrides = settings ?? {};
}

export function getSettingsOverrides(): GlobalSettings {
  return { ...overrides };
}

export function getShowUsd(): boolean {
  return overrides.showUsd ?? config.SHOW_USD;
}

/** Fraction (0.05 = 5%). The override is stored as a percent because that's what the operator types. */
export function getFloorMoveThreshold(): number {
  return overrides.floorMoveThresholdPercent !== undefined ? overrides.floorMoveThresholdPercent / 100 : config.FLOOR_MOVE_THRESHOLD;
}

export function getNewListingMaxPrice(): number {
  return overrides.newListingMaxPrice ?? config.NEW_LISTING_MAX_PRICE;
}

export function getOfferAboveCollectionThresholdPercent(): number {
  return overrides.offerAboveCollectionThresholdPercent ?? config.OFFER_ABOVE_COLLECTION_THRESHOLD_PERCENT;
}

export function getTrendAlertTimes(): string {
  return overrides.trendAlertTimes ?? config.TREND_ALERT_TIMES;
}

export function getDailyRecapTime(): string {
  return overrides.dailyRecapTime ?? config.DAILY_RECAP_TIME;
}

/** Human-readable current values + where each came from, for `/config show`. */
export function describeSettings(): Array<{ key: string; value: string; source: "discord" | "env" }> {
  return [
    { key: "show_usd", value: String(getShowUsd()), source: overrides.showUsd !== undefined ? "discord" : "env" },
    {
      key: "floor_move_threshold_percent",
      value: `${(getFloorMoveThreshold() * 100).toFixed(2)}%`,
      source: overrides.floorMoveThresholdPercent !== undefined ? "discord" : "env",
    },
    {
      key: "new_listing_max_price",
      value: String(getNewListingMaxPrice()),
      source: overrides.newListingMaxPrice !== undefined ? "discord" : "env",
    },
    {
      key: "offer_above_collection_percent",
      value: `${getOfferAboveCollectionThresholdPercent()}%`,
      source: overrides.offerAboveCollectionThresholdPercent !== undefined ? "discord" : "env",
    },
    { key: "trend_alert_times", value: getTrendAlertTimes(), source: overrides.trendAlertTimes !== undefined ? "discord" : "env" },
    { key: "daily_recap_time", value: getDailyRecapTime(), source: overrides.dailyRecapTime !== undefined ? "discord" : "env" },
  ];
}
