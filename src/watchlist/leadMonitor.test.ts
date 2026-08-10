import assert from "node:assert/strict";
import { test } from "node:test";
import { msUntilNext, parseTrendAlertTimes } from "./leadMonitor.js";

test("parseTrendAlertTimes: parses the default twice-daily schedule", () => {
  const times = parseTrendAlertTimes("08:00,20:00");
  assert.deepEqual(times, [
    { hour: 8, minute: 0 },
    { hour: 20, minute: 0 },
  ]);
});

test("parseTrendAlertTimes: trims whitespace and ignores empty entries", () => {
  const times = parseTrendAlertTimes(" 08:00 , 20:00, ");
  assert.deepEqual(times, [
    { hour: 8, minute: 0 },
    { hour: 20, minute: 0 },
  ]);
});

test("parseTrendAlertTimes: rejects malformed entries instead of silently ignoring them", () => {
  assert.throws(() => parseTrendAlertTimes("8am"), /Invalid TREND_ALERT_TIMES/);
  assert.throws(() => parseTrendAlertTimes("25:00"), /Invalid TREND_ALERT_TIMES/);
  assert.throws(() => parseTrendAlertTimes("08:60"), /Invalid TREND_ALERT_TIMES/);
});

test("msUntilNext: schedules later today when the time hasn't passed yet", () => {
  const from = new Date("2026-01-01T06:00:00");
  const delay = msUntilNext({ hour: 8, minute: 0 }, from);
  assert.equal(delay, 2 * 60 * 60 * 1000); // 2 hours
});

test("msUntilNext: rolls over to tomorrow when the time has already passed today", () => {
  const from = new Date("2026-01-01T21:00:00");
  const delay = msUntilNext({ hour: 20, minute: 0 }, from);
  // 3h to midnight + 20h to 20:00 tomorrow = 23h
  assert.equal(delay, 23 * 60 * 60 * 1000);
});

test("msUntilNext: rolls over when the time is exactly now (boundary)", () => {
  const from = new Date("2026-01-01T08:00:00");
  const delay = msUntilNext({ hour: 8, minute: 0 }, from);
  assert.equal(delay, 24 * 60 * 60 * 1000); // fires again tomorrow, not immediately
});
