import assert from "node:assert/strict";
import { test } from "node:test";
import { isWithinQuietHours, LeadLimiter } from "./limiter.js";
import type { AllowlistEntry } from "./schema.js";

function makeEntry(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    id: "test-entry",
    label: "Test entry",
    enabled: true,
    priorityTier: "watch",
    collection: "0xabc",
    filters: {},
    muted: false,
    dedupeWindowMinutes: 30,
    rateLimitPerHour: 3,
    ...overrides,
  };
}

test("LeadLimiter: muted entries are always suppressed", () => {
  const limiter = new LeadLimiter();
  const entry = makeEntry({ muted: true });
  assert.equal(limiter.check(entry, "key1"), "entry is muted");
});

test("LeadLimiter: dedupe window suppresses repeat leads for the same key", () => {
  const limiter = new LeadLimiter();
  const entry = makeEntry({ dedupeWindowMinutes: 30 });
  const t0 = new Date("2026-01-01T12:00:00Z");

  assert.equal(limiter.check(entry, "token-1", t0), null);
  limiter.recordFired(entry, "token-1", t0);

  const t1 = new Date(t0.getTime() + 10 * 60_000); // 10 min later, within 30-min window
  assert.equal(limiter.check(entry, "token-1", t1), "duplicate lead within dedupe window");

  const t2 = new Date(t0.getTime() + 31 * 60_000); // past the window
  assert.equal(limiter.check(entry, "token-1", t2), null);

  // A different token isn't deduped by the first token's fire.
  assert.equal(limiter.check(entry, "token-2", t1), null);
});

test("LeadLimiter: rate limit caps fires per rolling hour", () => {
  const limiter = new LeadLimiter();
  const entry = makeEntry({ rateLimitPerHour: 2, dedupeWindowMinutes: 0 });
  const t0 = new Date("2026-01-01T12:00:00Z");

  assert.equal(limiter.check(entry, "a", t0), null);
  limiter.recordFired(entry, "a", t0);
  const t1 = new Date(t0.getTime() + 60_000);
  assert.equal(limiter.check(entry, "b", t1), null);
  limiter.recordFired(entry, "b", t1);

  const t2 = new Date(t0.getTime() + 2 * 60_000);
  assert.equal(limiter.check(entry, "c", t2), "rate limit exceeded for this entry");

  // An hour after the first fire, that fire has rolled off the window.
  const t3 = new Date(t0.getTime() + 61 * 60_000);
  assert.equal(limiter.check(entry, "c", t3), null);
});

test("isWithinQuietHours: same-day window", () => {
  const quietHours = { start: "13:00", end: "17:00", timezone: "UTC" };
  assert.equal(isWithinQuietHours(quietHours, new Date("2026-01-01T14:00:00Z")), true);
  assert.equal(isWithinQuietHours(quietHours, new Date("2026-01-01T12:59:00Z")), false);
  assert.equal(isWithinQuietHours(quietHours, new Date("2026-01-01T17:00:00Z")), false);
});

test("isWithinQuietHours: window wraps past midnight", () => {
  const quietHours = { start: "23:00", end: "07:00", timezone: "UTC" };
  assert.equal(isWithinQuietHours(quietHours, new Date("2026-01-01T23:30:00Z")), true);
  assert.equal(isWithinQuietHours(quietHours, new Date("2026-01-02T03:00:00Z")), true);
  assert.equal(isWithinQuietHours(quietHours, new Date("2026-01-02T12:00:00Z")), false);
});

test("LeadLimiter: quiet hours suppress regardless of dedupe/rate-limit state", () => {
  const limiter = new LeadLimiter();
  const entry = makeEntry({ quietHours: { start: "00:00", end: "23:59", timezone: "UTC" } });
  assert.equal(limiter.check(entry, "key", new Date("2026-01-01T12:00:00Z")), "within quiet hours");
});
