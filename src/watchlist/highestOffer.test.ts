import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CollectionOfferInfo } from "../types/index.js";
import { decideHighestOffer, describeDelta, selectHighestOffer } from "./highestOffer.js";
import { HighestOfferStore, type HighestOfferRecord } from "./highestOfferStore.js";

function offer(overrides: Partial<CollectionOfferInfo> = {}): CollectionOfferInfo {
  return {
    id: "offer-1",
    collectionId: "0xabc",
    priceNative: 0.1,
    priceCurrency: "WETH",
    bidder: "0xbidder0000000000000000000000000000000000",
    source: "opensea",
    createdAt: "2026-08-11T00:00:00Z",
    scope: "collection",
    ...overrides,
  };
}

function record(overrides: Partial<HighestOfferRecord> = {}): HighestOfferRecord {
  return {
    offerId: "offer-1",
    priceNative: 0.1,
    priceCurrency: "WETH",
    scope: "collection",
    bidder: "0xbidder0000000000000000000000000000000000",
    recordedAt: "2026-08-11T00:00:00Z",
    ...overrides,
  };
}

const NOW = new Date("2026-08-11T12:00:00Z");

// --- selectHighestOffer -------------------------------------------------

test("selectHighestOffer: takes the max across collection, trait, and item scopes", () => {
  const best = selectHighestOffer([
    offer({ id: "a", priceNative: 0.1, scope: "collection" }),
    offer({ id: "b", priceNative: 0.4, scope: "trait" }),
    offer({ id: "c", priceNative: 0.25, scope: "token" }),
  ]);
  assert.equal(best?.id, "b");
  assert.equal(best?.priceNative, 0.4);
});

test("selectHighestOffer: ignores zero, negative, and non-finite prices", () => {
  const best = selectHighestOffer([
    offer({ id: "zero", priceNative: 0 }),
    offer({ id: "neg", priceNative: -1 }),
    offer({ id: "nan", priceNative: Number.NaN }),
    offer({ id: "real", priceNative: 0.05 }),
  ]);
  assert.equal(best?.id, "real");
});

test("selectHighestOffer: ties break deterministically by id, independent of input order", () => {
  const tied = [offer({ id: "zzz", priceNative: 0.3 }), offer({ id: "aaa", priceNative: 0.3 })];
  assert.equal(selectHighestOffer(tied)?.id, "aaa");
  assert.equal(selectHighestOffer([...tied].reverse())?.id, "aaa");
});

test("selectHighestOffer: empty input yields null", () => {
  assert.equal(selectHighestOffer([]), null);
});

// --- Baseline (no-backfill) ---------------------------------------------

test("decideHighestOffer: first run BASELINES silently instead of posting", () => {
  // This is the no-backfill guarantee: adding a collection (or restarting)
  // must not dump the existing high as though it just happened.
  const decision = decideHighestOffer([offer({ priceNative: 0.5 })], undefined, NOW);
  assert.equal(decision.action, "baseline");
  assert.equal(decision.action === "baseline" && decision.reason, "first-run");
  assert.equal(decision.action === "baseline" && decision.record.priceNative, 0.5);
});

test("decideHighestOffer: no offers at all is a no-op", () => {
  const decision = decideHighestOffer([], undefined, NOW);
  assert.equal(decision.action, "none");
  assert.equal(decision.action === "none" && decision.reason, "no-offers");
});

// --- New records --------------------------------------------------------

test("decideHighestOffer: a strictly higher offer POSTS with the previous high attached", () => {
  const stored = record({ offerId: "old", priceNative: 0.18 });
  const offers = [offer({ id: "old", priceNative: 0.18 }), offer({ id: "new", priceNative: 0.21 })];

  const decision = decideHighestOffer(offers, stored, NOW);
  assert.equal(decision.action, "post");
  if (decision.action !== "post") return;
  assert.equal(decision.record.priceNative, 0.21);
  assert.equal(decision.previous.priceNative, 0.18);
});

test("decideHighestOffer: a DIFFERENT offer at an equal value is NOT a new record", () => {
  // Ids chosen so the tie-break picks the new offer ("aaa" < "zzz"), which
  // is what forces the not-a-new-high branch rather than the same-offer one.
  const stored = record({ offerId: "zzz", priceNative: 0.2 });
  const offers = [offer({ id: "zzz", priceNative: 0.2 }), offer({ id: "aaa", priceNative: 0.2 })];

  const decision = decideHighestOffer(offers, stored, NOW);
  assert.equal(decision.action, "none");
  assert.equal(decision.action === "none" && decision.reason, "not-a-new-high", "matching the high must not count as beating it");
});

test("decideHighestOffer: a lower offer while the record still stands is a no-op", () => {
  const stored = record({ offerId: "old", priceNative: 0.5 });
  const offers = [offer({ id: "old", priceNative: 0.5 }), offer({ id: "low", priceNative: 0.2 })];

  assert.equal(decideHighestOffer(offers, stored, NOW).action, "none");
});

test("decideHighestOffer: the SAME standing offer never reposts (dedupe)", () => {
  // A standing top offer is re-observed on every hourly poll; it must not
  // produce an hourly notification.
  const stored = record({ offerId: "standing", priceNative: 0.3 });
  const offers = [offer({ id: "standing", priceNative: 0.3 })];

  for (let tick = 0; tick < 5; tick++) {
    const decision = decideHighestOffer(offers, stored, NOW);
    assert.equal(decision.action, "none");
    assert.equal(decision.action === "none" && decision.reason, "same-offer");
  }
});

// --- Expired record -----------------------------------------------------

test("decideHighestOffer: an EXPIRED record re-baselines silently rather than posting a lower high", () => {
  // Without this, one outlier offer would raise the bar permanently and the
  // channel would go silent forever once it expired.
  const stored = record({ offerId: "gone", priceNative: 5 });
  const offers = [offer({ id: "current", priceNative: 0.2 })];

  const decision = decideHighestOffer(offers, stored, NOW);
  assert.equal(decision.action, "baseline");
  assert.equal(decision.action === "baseline" && decision.reason, "record-expired");
  assert.equal(decision.action === "baseline" && decision.record.priceNative, 0.2);
});

test("decideHighestOffer: after an expired record re-baselines, the next genuine rise posts", () => {
  const stored = record({ offerId: "gone", priceNative: 5 });
  const rebaselined = decideHighestOffer([offer({ id: "current", priceNative: 0.2 })], stored, NOW);
  assert.equal(rebaselined.action, "baseline");
  if (rebaselined.action !== "baseline") return;

  const next = decideHighestOffer(
    [offer({ id: "current", priceNative: 0.2 }), offer({ id: "higher", priceNative: 0.35 })],
    rebaselined.record,
    NOW,
  );
  assert.equal(next.action, "post");
  assert.equal(next.action === "post" && next.record.priceNative, 0.35);
});

// --- Record contents ----------------------------------------------------

test("decideHighestOffer: the record carries scope, bidder, and currency for the embed", () => {
  const decision = decideHighestOffer(
    [offer({ id: "x", priceNative: 0.9, scope: "trait", bidder: "0xwhale", priceCurrency: "WETH" })],
    undefined,
    NOW,
  );
  assert.equal(decision.action, "baseline");
  if (decision.action !== "baseline") return;
  assert.equal(decision.record.scope, "trait");
  assert.equal(decision.record.bidder, "0xwhale");
  assert.equal(decision.record.priceCurrency, "WETH");
  assert.equal(decision.record.recordedAt, NOW.toISOString());
});

// --- describeDelta ------------------------------------------------------

test("describeDelta: reports the rise and percentage", () => {
  assert.match(describeDelta(0.21, 0.18), /up from 0\.18/);
  assert.match(describeDelta(0.21, 0.18), /16\.7%/);
});

test("describeDelta: a zero previous high doesn't divide by zero", () => {
  assert.equal(describeDelta(0.2, 0), "first recorded high");
});

// --- HighestOfferStore --------------------------------------------------

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "highest-offer-")), "highest.json");
}

test("HighestOfferStore: round-trips a record and is case-insensitive on the collection id", () => {
  const store = new HighestOfferStore(tempPath());
  store.set("0xAbC", record({ priceNative: 0.42 }));

  assert.equal(store.get("0xabc")?.priceNative, 0.42);
  assert.equal(store.get("0xABC")?.priceNative, 0.42);
});

test("HighestOfferStore: persists across instances so a restart doesn't re-post the high", () => {
  const path = tempPath();
  new HighestOfferStore(path).set("0xabc", record({ priceNative: 0.42 }));

  assert.equal(new HighestOfferStore(path).get("0xabc")?.priceNative, 0.42);
});

test("HighestOfferStore: forget drops one collection", () => {
  const store = new HighestOfferStore(tempPath());
  store.set("0xabc", record());
  store.set("0xdef", record());
  store.forget("0xabc");

  assert.equal(store.get("0xabc"), undefined);
  assert.ok(store.get("0xdef"));
});

test("HighestOfferStore: a corrupt file starts fresh rather than throwing", () => {
  const path = tempPath();
  writeFileSync(path, "not json at all", "utf8");
  assert.deepEqual(new HighestOfferStore(path).getAll(), []);
});

test("HighestOfferStore: an entry with a non-numeric price is discarded, so it re-baselines", () => {
  const path = tempPath();
  writeFileSync(path, JSON.stringify({ "0xbad": { offerId: "x", priceNative: "lots" }, "0xgood": record({ priceNative: 1 }) }), "utf8");

  const store = new HighestOfferStore(path);
  assert.equal(store.get("0xbad"), undefined);
  assert.equal(store.get("0xgood")?.priceNative, 1);
});
