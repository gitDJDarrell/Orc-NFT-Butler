import { allowlistConfigSchema, globalSettingsSchema, type AllowlistConfig, type GlobalSettings } from "./schema.js";

/**
 * Pure planners for `/config` (Group 3.4): each takes the current config and
 * returns either a rejection with a human-readable reason, or a NEW config
 * object to write. Nothing here touches disk, Discord, or the live monitor —
 * the caller (client.ts) saves and reloads, exactly like planAddEntry.
 *
 * Every mutation is re-validated against the Zod schema before being
 * returned, so an out-of-range value is rejected here rather than corrupting
 * watchlist.json.
 */

export type PlanResult<T> = { ok: true; config: AllowlistConfig; detail: T } | { ok: false; message: string };

/** The global tunables `/config set` can change, and how to parse each from a string. */
export type GlobalSettingKey =
  | "show_usd"
  | "floor_move_threshold_percent"
  | "new_listing_max_price"
  | "offer_above_collection_percent"
  | "trend_alert_times"
  | "daily_recap_time";

export const GLOBAL_SETTING_KEYS: GlobalSettingKey[] = [
  "show_usd",
  "floor_move_threshold_percent",
  "new_listing_max_price",
  "offer_above_collection_percent",
  "trend_alert_times",
  "daily_recap_time",
];

const SETTING_FIELD: Record<GlobalSettingKey, keyof GlobalSettings> = {
  show_usd: "showUsd",
  floor_move_threshold_percent: "floorMoveThresholdPercent",
  new_listing_max_price: "newListingMaxPrice",
  offer_above_collection_percent: "offerAboveCollectionThresholdPercent",
  trend_alert_times: "trendAlertTimes",
  daily_recap_time: "dailyRecapTime",
};

function parseBoolean(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (["true", "on", "yes", "1", "enabled"].includes(v)) return true;
  if (["false", "off", "no", "0", "disabled"].includes(v)) return false;
  return null;
}

function parseNumber(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Sets one global tunable. String/number/boolean parsing happens here, then
 * the whole `settings` object is validated by globalSettingsSchema — so
 * range violations (e.g. a 500% floor-move threshold, or a malformed
 * "25:00" time) are rejected with the schema's own message.
 */
export function planSetGlobalSetting(config: AllowlistConfig, key: GlobalSettingKey, rawValue: string): PlanResult<{ key: GlobalSettingKey; value: unknown }> {
  const field = SETTING_FIELD[key];
  if (!field) return { ok: false, message: `Unknown setting \`${key}\`.` };

  let value: unknown;
  switch (key) {
    case "show_usd": {
      const parsed = parseBoolean(rawValue);
      if (parsed === null) return { ok: false, message: `\`${rawValue}\` isn't a boolean — use \`true\` or \`false\`.` };
      value = parsed;
      break;
    }
    case "floor_move_threshold_percent":
    case "new_listing_max_price":
    case "offer_above_collection_percent": {
      const parsed = parseNumber(rawValue);
      if (parsed === null) return { ok: false, message: `\`${rawValue}\` isn't a number.` };
      value = parsed;
      break;
    }
    case "trend_alert_times":
    case "daily_recap_time":
      value = rawValue.trim();
      break;
  }

  const nextSettings: GlobalSettings = { ...(config.settings ?? {}), [field]: value };
  const validated = globalSettingsSchema.safeParse(nextSettings);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    return { ok: false, message: `Rejected: ${issue?.path.join(".") ?? key} — ${issue?.message ?? "invalid value"}.` };
  }

  const nextConfig: AllowlistConfig = { ...config, settings: validated.data };
  const check = allowlistConfigSchema.safeParse(nextConfig);
  if (!check.success) return { ok: false, message: `Rejected: ${check.error.issues[0]?.message ?? "invalid config"}.` };

  return { ok: true, config: check.data, detail: { key, value } };
}

/** Clears one global override, falling the tunable back to its .env value. */
export function planResetGlobalSetting(config: AllowlistConfig, key: GlobalSettingKey): PlanResult<{ key: GlobalSettingKey }> {
  const field = SETTING_FIELD[key];
  if (!field) return { ok: false, message: `Unknown setting \`${key}\`.` };
  if (!config.settings || config.settings[field] === undefined) {
    return { ok: false, message: `\`${key}\` isn't overridden — it's already using the .env value.` };
  }

  const nextSettings: GlobalSettings = { ...config.settings };
  delete nextSettings[field];

  const nextConfig: AllowlistConfig = { ...config, settings: Object.keys(nextSettings).length > 0 ? nextSettings : undefined };
  const check = allowlistConfigSchema.safeParse(nextConfig);
  if (!check.success) return { ok: false, message: `Rejected: ${check.error.issues[0]?.message ?? "invalid config"}.` };

  return { ok: true, config: check.data, detail: { key } };
}

/** Per-entry tunables `/config entry` can change. */
export type EntrySettingKey =
  | "muted"
  | "enabled"
  | "target_buy_price"
  | "max_floor"
  | "min_percent_from_floor"
  | "max_percent_from_floor"
  | "dedupe_window_minutes"
  | "rate_limit_per_hour"
  | "quiet_hours_start"
  | "quiet_hours_end"
  | "quiet_hours_timezone"
  | "priority_tier";

export const ENTRY_SETTING_KEYS: EntrySettingKey[] = [
  "muted",
  "enabled",
  "target_buy_price",
  "max_floor",
  "min_percent_from_floor",
  "max_percent_from_floor",
  "dedupe_window_minutes",
  "rate_limit_per_hour",
  "quiet_hours_start",
  "quiet_hours_end",
  "quiet_hours_timezone",
  "priority_tier",
];

const DEFAULT_QUIET_HOURS = { start: "22:00", end: "08:00", timezone: "UTC" };

/**
 * Sets one tunable on ONE allowlist entry, matched by collection address or
 * label (case-insensitive). Quiet-hours fields lazily create a full
 * quietHours block (the schema requires start+end together) using sensible
 * defaults for whichever half isn't being set.
 */
export function planSetEntrySetting(
  config: AllowlistConfig,
  entryMatcher: string,
  key: EntrySettingKey,
  rawValue: string,
): PlanResult<{ label: string; key: EntrySettingKey; value: unknown }> {
  const needle = entryMatcher.trim().toLowerCase();
  const index = config.entries.findIndex((e) => e.collection.toLowerCase() === needle || e.label.toLowerCase() === needle || e.id.toLowerCase() === needle);
  if (index === -1) {
    return { ok: false, message: `No watchlist entry matches "${entryMatcher}". Run \`/watchlist list\` to see what's tracked.` };
  }

  const entry = structuredClone(config.entries[index]!);
  let applied: unknown;

  switch (key) {
    case "muted":
    case "enabled": {
      const parsed = parseBoolean(rawValue);
      if (parsed === null) return { ok: false, message: `\`${rawValue}\` isn't a boolean — use \`true\` or \`false\`.` };
      entry[key === "muted" ? "muted" : "enabled"] = parsed;
      applied = parsed;
      break;
    }
    case "target_buy_price":
    case "max_floor": {
      const parsed = parseNumber(rawValue);
      if (parsed === null || parsed < 0) return { ok: false, message: `\`${rawValue}\` must be a non-negative number.` };
      entry.filters.priceBand = { ...(entry.filters.priceBand ?? {}), [key === "target_buy_price" ? "targetBuyPrice" : "maxFloor"]: parsed };
      applied = parsed;
      break;
    }
    case "min_percent_from_floor":
    case "max_percent_from_floor": {
      const parsed = parseNumber(rawValue);
      if (parsed === null) return { ok: false, message: `\`${rawValue}\` isn't a number.` };
      entry.filters.bidSpread = {
        ...(entry.filters.bidSpread ?? {}),
        [key === "min_percent_from_floor" ? "minPercentFromFloor" : "maxPercentFromFloor"]: parsed,
      };
      applied = parsed;
      break;
    }
    case "dedupe_window_minutes": {
      const parsed = parseNumber(rawValue);
      if (parsed === null || parsed < 0) return { ok: false, message: `\`${rawValue}\` must be a non-negative number of minutes.` };
      entry.dedupeWindowMinutes = parsed;
      applied = parsed;
      break;
    }
    case "rate_limit_per_hour": {
      const parsed = parseNumber(rawValue);
      if (parsed === null || parsed <= 0) return { ok: false, message: `\`${rawValue}\` must be a positive number.` };
      entry.rateLimitPerHour = parsed;
      applied = parsed;
      break;
    }
    case "quiet_hours_start":
    case "quiet_hours_end":
    case "quiet_hours_timezone": {
      const current = entry.quietHours ?? { ...DEFAULT_QUIET_HOURS };
      const field = key === "quiet_hours_start" ? "start" : key === "quiet_hours_end" ? "end" : "timezone";
      if (field === "timezone") {
        // Validate against the runtime's own tz database rather than a
        // hardcoded list — an unknown zone would otherwise only blow up
        // later, inside isWithinQuietHours.
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: rawValue.trim() });
        } catch {
          return { ok: false, message: `\`${rawValue}\` isn't a recognized IANA timezone (e.g. \`America/New_York\`).` };
        }
      }
      entry.quietHours = { ...current, [field]: rawValue.trim() };
      applied = rawValue.trim();
      break;
    }
    case "priority_tier": {
      const v = rawValue.trim().toLowerCase();
      if (v !== "blue-chip" && v !== "watch") return { ok: false, message: "`priority_tier` must be `blue-chip` or `watch`." };
      entry.priorityTier = v;
      applied = v;
      break;
    }
  }

  const nextEntries = [...config.entries];
  nextEntries[index] = entry;
  const nextConfig: AllowlistConfig = { ...config, entries: nextEntries };

  const check = allowlistConfigSchema.safeParse(nextConfig);
  if (!check.success) {
    const issue = check.error.issues[0];
    return { ok: false, message: `Rejected: ${issue?.path.join(".") ?? key} — ${issue?.message ?? "invalid value"}.` };
  }

  return { ok: true, config: check.data, detail: { label: entry.label, key, value: applied } };
}
