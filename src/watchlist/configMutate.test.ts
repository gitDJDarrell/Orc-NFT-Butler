import assert from "node:assert/strict";
import test from "node:test";
import { planResetGlobalSetting, planSetEntrySetting, planSetGlobalSetting } from "./configMutate.js";
import type { AllowlistConfig } from "./schema.js";

function makeConfig(overrides: Partial<AllowlistConfig> = {}): AllowlistConfig {
  return {
    entries: [
      {
        id: "spw",
        label: "Super Punk World",
        enabled: true,
        priorityTier: "watch",
        collection: "0x0000000000003f07248ddfb9821770a8200ef77d",
        filters: {},
        muted: false,
        dedupeWindowMinutes: 30,
        rateLimitPerHour: 8,
      },
    ],
    ...overrides,
  };
}

// --- Global settings ---

test("planSetGlobalSetting: sets a boolean tunable", () => {
  const result = planSetGlobalSetting(makeConfig(), "show_usd", "false");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.config.settings?.showUsd, false);
});

test("planSetGlobalSetting: accepts friendly boolean spellings", () => {
  for (const raw of ["true", "on", "yes", "1", "enabled"]) {
    const result = planSetGlobalSetting(makeConfig(), "show_usd", raw);
    assert.equal(result.ok && result.config.settings?.showUsd, true, `"${raw}" should parse as true`);
  }
  for (const raw of ["false", "off", "no", "0", "disabled"]) {
    const result = planSetGlobalSetting(makeConfig(), "show_usd", raw);
    assert.equal(result.ok && result.config.settings?.showUsd, false, `"${raw}" should parse as false`);
  }
});

test("planSetGlobalSetting: rejects a non-boolean for a boolean tunable", () => {
  const result = planSetGlobalSetting(makeConfig(), "show_usd", "maybe");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /isn't a boolean/i);
});

test("planSetGlobalSetting: rejects an out-of-range number via the schema", () => {
  // 500% is a nonsense floor-move threshold; the schema's max is what
  // catches it, so this also proves validation actually runs.
  const result = planSetGlobalSetting(makeConfig(), "floor_move_threshold_percent", "500");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /rejected/i);
});

test("planSetGlobalSetting: rejects a non-numeric number", () => {
  const result = planSetGlobalSetting(makeConfig(), "new_listing_max_price", "cheap");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /isn't a number/i);
});

test("planSetGlobalSetting: validates time formats", () => {
  const good = planSetGlobalSetting(makeConfig(), "trend_alert_times", "08:00,20:00");
  assert.equal(good.ok, true);

  for (const bad of ["25:00", "8am", "08:60", "08:00,"]) {
    const result = planSetGlobalSetting(makeConfig(), "trend_alert_times", bad);
    assert.equal(result.ok, false, `"${bad}" should be rejected`);
  }
});

test("planSetGlobalSetting: preserves other existing overrides", () => {
  const withOne = planSetGlobalSetting(makeConfig(), "show_usd", "false");
  assert.equal(withOne.ok, true);
  const withTwo = planSetGlobalSetting(withOne.ok ? withOne.config : makeConfig(), "daily_recap_time", "06:30");

  assert.equal(withTwo.ok && withTwo.config.settings?.showUsd, false);
  assert.equal(withTwo.ok && withTwo.config.settings?.dailyRecapTime, "06:30");
});

test("planSetGlobalSetting: does not mutate the input config", () => {
  const original = makeConfig();
  planSetGlobalSetting(original, "show_usd", "false");
  assert.equal(original.settings, undefined);
});

test("planResetGlobalSetting: clears an override so .env takes over again", () => {
  const set = planSetGlobalSetting(makeConfig(), "show_usd", "false");
  assert.equal(set.ok, true);

  const reset = planResetGlobalSetting(set.ok ? set.config : makeConfig(), "show_usd");
  assert.equal(reset.ok, true);
  assert.equal(reset.ok && reset.config.settings?.showUsd, undefined);
});

test("planResetGlobalSetting: refuses to reset something that isn't overridden", () => {
  const result = planResetGlobalSetting(makeConfig(), "show_usd");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /isn't overridden/i);
});

// --- Per-entry settings ---

test("planSetEntrySetting: mutes an entry, matched by address", () => {
  const result = planSetEntrySetting(makeConfig(), "0x0000000000003f07248ddfb9821770a8200ef77d", "muted", "true");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.config.entries[0]!.muted, true);
});

test("planSetEntrySetting: matches by label, case-insensitively", () => {
  const result = planSetEntrySetting(makeConfig(), "super punk world", "muted", "true");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.config.entries[0]!.muted, true);
});

test("planSetEntrySetting: reports a helpful error for an unknown entry", () => {
  const result = planSetEntrySetting(makeConfig(), "Nonexistent Collection", "muted", "true");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /no watchlist entry matches/i);
});

test("planSetEntrySetting: sets nested price-band and bid-spread filters", () => {
  const priced = planSetEntrySetting(makeConfig(), "spw", "target_buy_price", "0.25");
  assert.equal(priced.ok && priced.config.entries[0]!.filters.priceBand?.targetBuyPrice, 0.25);

  const spread = planSetEntrySetting(priced.ok ? priced.config : makeConfig(), "spw", "min_percent_from_floor", "-30");
  assert.equal(spread.ok && spread.config.entries[0]!.filters.bidSpread?.minPercentFromFloor, -30);
  // The earlier price-band edit must survive the second one.
  assert.equal(spread.ok && spread.config.entries[0]!.filters.priceBand?.targetBuyPrice, 0.25);
});

test("planSetEntrySetting: creates a complete quietHours block from a single field", () => {
  // The schema requires start+end together, so setting just one has to fill
  // the other from a default rather than writing an invalid partial block.
  const result = planSetEntrySetting(makeConfig(), "spw", "quiet_hours_start", "23:00");
  assert.equal(result.ok, true);
  const quietHours = result.ok ? result.config.entries[0]!.quietHours : undefined;
  assert.equal(quietHours?.start, "23:00");
  assert.ok(quietHours?.end, "end must be populated for the schema to accept it");
  assert.ok(quietHours?.timezone);
});

test("planSetEntrySetting: rejects an unrecognized timezone", () => {
  const result = planSetEntrySetting(makeConfig(), "spw", "quiet_hours_timezone", "Mars/Olympus_Mons");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /IANA timezone/i);
});

test("planSetEntrySetting: accepts a real IANA timezone", () => {
  const result = planSetEntrySetting(makeConfig(), "spw", "quiet_hours_timezone", "America/New_York");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.config.entries[0]!.quietHours?.timezone, "America/New_York");
});

test("planSetEntrySetting: rejects an invalid priority tier and a non-positive rate limit", () => {
  const tier = planSetEntrySetting(makeConfig(), "spw", "priority_tier", "platinum");
  assert.equal(tier.ok, false);

  const rate = planSetEntrySetting(makeConfig(), "spw", "rate_limit_per_hour", "0");
  assert.equal(rate.ok, false);
});

test("planSetEntrySetting: does not mutate the input config", () => {
  const original = makeConfig();
  planSetEntrySetting(original, "spw", "muted", "true");
  assert.equal(original.entries[0]!.muted, false);
});
