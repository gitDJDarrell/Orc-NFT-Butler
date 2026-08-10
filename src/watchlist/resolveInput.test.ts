import assert from "node:assert/strict";
import { test } from "node:test";
import { findWatchlistNameMatch, normalizeName, suggestClosestWatchlistEntry } from "./resolveInput.js";
import type { AllowlistEntry } from "./schema.js";

function makeEntry(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    id: "super-punk-world-watch",
    label: "Super Punk World — Nina Chanel Abney",
    enabled: true,
    priorityTier: "watch",
    collection: "0x0000000000003f07248ddfb9821770a8200ef77d",
    filters: {},
    muted: false,
    dedupeWindowMinutes: 30,
    rateLimitPerHour: 8,
    ...overrides,
  };
}

test("normalizeName: lowercases and strips spaces/punctuation", () => {
  assert.equal(normalizeName("Super Punk World"), "superpunkworld");
  assert.equal(normalizeName("super-punk-world!!"), "superpunkworld");
  assert.equal(normalizeName("  Super   Punk World  "), "superpunkworld");
});

test("findWatchlistNameMatch: matches a friendly short name against a longer label with a subtitle", () => {
  const entries = [makeEntry()];
  const match = findWatchlistNameMatch("super punk world", entries);
  assert.equal(match?.id, "super-punk-world-watch");
});

test("findWatchlistNameMatch: is case/punctuation insensitive", () => {
  const entries = [makeEntry()];
  assert.equal(findWatchlistNameMatch("SUPER-PUNK-WORLD", entries)?.id, "super-punk-world-watch");
  assert.equal(findWatchlistNameMatch("super_punk_world", entries)?.id, "super-punk-world-watch");
});

test("findWatchlistNameMatch: matches the exact full label too", () => {
  const entries = [makeEntry()];
  const match = findWatchlistNameMatch("Super Punk World — Nina Chanel Abney", entries);
  assert.equal(match?.id, "super-punk-world-watch");
});

test("findWatchlistNameMatch: ignores disabled entries", () => {
  const entries = [makeEntry({ enabled: false })];
  assert.equal(findWatchlistNameMatch("super punk world", entries), null);
});

test("findWatchlistNameMatch: returns null when nothing matches", () => {
  const entries = [makeEntry()];
  assert.equal(findWatchlistNameMatch("totally unrelated collection", entries), null);
});

test("findWatchlistNameMatch: returns null for empty input", () => {
  const entries = [makeEntry()];
  assert.equal(findWatchlistNameMatch("   ", entries), null);
});

test("findWatchlistNameMatch: picks the best entry among multiple enabled entries", () => {
  const entries = [makeEntry(), makeEntry({ id: "azuki-watch", label: "Azuki", collection: "0xazuki" })];
  assert.equal(findWatchlistNameMatch("azuki", entries)?.id, "azuki-watch");
  assert.equal(findWatchlistNameMatch("super punk world", entries)?.id, "super-punk-world-watch");
});

test("suggestClosestWatchlistEntry: suggests a close-but-not-exact match", () => {
  const entries = [makeEntry()];
  const suggestion = suggestClosestWatchlistEntry("super punk wrld", entries);
  assert.equal(suggestion?.id, "super-punk-world-watch");
});

test("suggestClosestWatchlistEntry: returns null when nothing is close enough", () => {
  const entries = [makeEntry()];
  assert.equal(suggestClosestWatchlistEntry("xyz", entries), null);
});

test("suggestClosestWatchlistEntry: ignores disabled entries", () => {
  const entries = [makeEntry({ enabled: false })];
  assert.equal(suggestClosestWatchlistEntry("super punk world", entries), null);
});
