import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHighestOfferEmbed } from "../discord-bot/embeds.js";
import type { CollectionOfferInfo } from "../types/index.js";
import {
  SCOPE_KEY_COLLECTION,
  SCOPE_KEY_ITEM,
  decideForScope,
  decideHighestOffers,
  describeDelta,
  describeScope,
  groupOffersByScope,
  scopeKeyFor,
  selectHighestOffer,
} from "./highestOffer.js";
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
    scopeKey: SCOPE_KEY_COLLECTION,
    priceNative: 0.1,
    priceCurrency: "WETH",
    scope: "collection",
    bidder: "0xbidder0000000000000000000000000000000000",
    recordedAt: "2026-08-11T00:00:00Z",
    ...overrides,
  };
}

const NOW = new Date("2026-08-11T12:00:00Z");

// --- Scope keying -------------------------------------------------------

test("scopeKeyFor: the three scopes map to distinct keys, and traits are keyed individually", () => {
  assert.equal(scopeKeyFor(offer({ scope: "collection" })), SCOPE_KEY_COLLECTION);
  assert.equal(scopeKeyFor(offer({ scope: "token", tokenId: "42" })), SCOPE_KEY_ITEM);
  assert.equal(scopeKeyFor(offer({ scope: "trait", trait: { key: "Background", value: "Blue" } })), "trait:Background=Blue");
  assert.equal(scopeKeyFor(offer({ scope: "trait", trait: { key: "Fur", value: "Gold" } })), "trait:Fur=Gold");
});

test("scopeKeyFor: every item offer shares one key regardless of token", () => {
  assert.equal(scopeKeyFor(offer({ scope: "token", tokenId: "1" })), scopeKeyFor(offer({ scope: "token", tokenId: "999" })));
});

test("groupOffersByScope: buckets a mixed tick into independent markets", () => {
  const grouped = groupOffersByScope([
    offer({ id: "c1", scope: "collection" }),
    offer({ id: "t1", scope: "trait", trait: { key: "Background", value: "Blue" } }),
    offer({ id: "t2", scope: "trait", trait: { key: "Fur", value: "Gold" } }),
    offer({ id: "i1", scope: "token", tokenId: "7" }),
    offer({ id: "i2", scope: "token", tokenId: "8" }),
  ]);

  assert.equal(grouped.size, 4);
  assert.equal(grouped.get(SCOPE_KEY_COLLECTION)?.length, 1);
  assert.equal(grouped.get("trait:Background=Blue")?.length, 1);
  assert.equal(grouped.get("trait:Fur=Gold")?.length, 1);
  assert.equal(grouped.get(SCOPE_KEY_ITEM)?.length, 2);
});

// --- Per-scope independence (the core of this refinement) ---------------

test("a huge ITEM offer does NOT mask a new collection-wide record", () => {
  // The whole reason for per-scope tracking: one blended max would let a
  // 5 ETH item offer permanently suppress every collection-wide record.
  const stored = {
    [SCOPE_KEY_COLLECTION]: record({ offerId: "c-old", priceNative: 0.1, scopeKey: SCOPE_KEY_COLLECTION }),
    [SCOPE_KEY_ITEM]: record({ offerId: "i-old", priceNative: 5, scope: "token", scopeKey: SCOPE_KEY_ITEM }),
  };
  const offers = [
    offer({ id: "c-old", priceNative: 0.1, scope: "collection" }),
    offer({ id: "c-new", priceNative: 0.2, scope: "collection" }),
    offer({ id: "i-old", priceNative: 5, scope: "token", tokenId: "1" }),
  ];

  const decisions = decideHighestOffers(offers, stored, NOW);
  const collectionDecision = decisions.find((d) => d.scopeKey === SCOPE_KEY_COLLECTION);
  assert.equal(collectionDecision?.action, "post", "0.2 beats the 0.1 collection record even though an item offer sits at 5");
  assert.equal(collectionDecision?.action === "post" && collectionDecision.previous.priceNative, 0.1);
});

test("each trait keeps its own record — a Gold record doesn't gate a Blue one", () => {
  const stored = {
    "trait:Background=Blue": record({ offerId: "b-old", priceNative: 0.1, scope: "trait", scopeKey: "trait:Background=Blue" }),
    "trait:Fur=Gold": record({ offerId: "g-old", priceNative: 9, scope: "trait", scopeKey: "trait:Fur=Gold" }),
  };
  const offers = [
    offer({ id: "b-old", priceNative: 0.1, scope: "trait", trait: { key: "Background", value: "Blue" } }),
    offer({ id: "b-new", priceNative: 0.15, scope: "trait", trait: { key: "Background", value: "Blue" } }),
    offer({ id: "g-old", priceNative: 9, scope: "trait", trait: { key: "Fur", value: "Gold" } }),
  ];

  const decisions = decideHighestOffers(offers, stored, NOW);
  assert.equal(decisions.find((d) => d.scopeKey === "trait:Background=Blue")?.action, "post");
  assert.equal(decisions.find((d) => d.scopeKey === "trait:Fur=Gold")?.action, "none");
});

test("multiple scopes can set records on the same tick", () => {
  const stored = {
    [SCOPE_KEY_COLLECTION]: record({ offerId: "c-old", priceNative: 0.1, scopeKey: SCOPE_KEY_COLLECTION }),
    [SCOPE_KEY_ITEM]: record({ offerId: "i-old", priceNative: 0.3, scope: "token", scopeKey: SCOPE_KEY_ITEM }),
  };
  const offers = [
    offer({ id: "c-old", priceNative: 0.1, scope: "collection" }),
    offer({ id: "c-new", priceNative: 0.2, scope: "collection" }),
    offer({ id: "i-old", priceNative: 0.3, scope: "token", tokenId: "1" }),
    offer({ id: "i-new", priceNative: 0.4, scope: "token", tokenId: "2" }),
  ];

  const posts = decideHighestOffers(offers, stored, NOW).filter((d) => d.action === "post");
  assert.equal(posts.length, 2, "both the collection and item scopes hit new highs");
});

// --- Baseline / dedupe / expiry, per scope ------------------------------

test("first run baselines EVERY scope silently — no backfill", () => {
  const offers = [
    offer({ id: "c", priceNative: 0.1, scope: "collection" }),
    offer({ id: "t", priceNative: 0.2, scope: "trait", trait: { key: "Background", value: "Blue" } }),
    offer({ id: "i", priceNative: 0.3, scope: "token", tokenId: "5" }),
  ];

  const decisions = decideHighestOffers(offers, {}, NOW);
  assert.equal(decisions.length, 3);
  assert.ok(decisions.every((d) => d.action === "baseline"), "nothing may post on a first run");
});

test("a standing top offer never reposts within its scope", () => {
  const stored = { [SCOPE_KEY_COLLECTION]: record({ offerId: "standing", priceNative: 0.3 }) };
  const offers = [offer({ id: "standing", priceNative: 0.3, scope: "collection" })];

  for (let tick = 0; tick < 5; tick++) {
    const [decision] = decideHighestOffers(offers, stored, NOW);
    assert.equal(decision?.action, "none");
    assert.equal(decision?.action === "none" && decision.reason, "same-offer");
  }
});

test("an equal-value offer from a different order is not a new record", () => {
  // Ids chosen so the tie-break picks the new offer, forcing the
  // not-a-new-high branch rather than same-offer.
  const stored = { [SCOPE_KEY_COLLECTION]: record({ offerId: "zzz", priceNative: 0.2 }) };
  const offers = [offer({ id: "zzz", priceNative: 0.2 }), offer({ id: "aaa", priceNative: 0.2 })];

  const [decision] = decideHighestOffers(offers, stored, NOW);
  assert.equal(decision?.action, "none");
  assert.equal(decision?.action === "none" && decision.reason, "not-a-new-high");
});

test("an expired record re-baselines silently within its own scope", () => {
  const stored = { [SCOPE_KEY_COLLECTION]: record({ offerId: "gone", priceNative: 5 }) };
  const offers = [offer({ id: "current", priceNative: 0.2, scope: "collection" })];

  const [decision] = decideHighestOffers(offers, stored, NOW);
  assert.equal(decision?.action, "baseline");
  assert.equal(decision?.action === "baseline" && decision.reason, "record-expired");
});

test("a scope with a stored record but no offers this tick is left untouched", () => {
  const stored = { [SCOPE_KEY_ITEM]: record({ offerId: "i", priceNative: 1, scope: "token", scopeKey: SCOPE_KEY_ITEM }) };
  const decisions = decideHighestOffers([offer({ id: "c", scope: "collection" })], stored, NOW);

  assert.equal(decisions.length, 1, "only the scope present this tick is decided");
  assert.equal(decisions[0]!.scopeKey, SCOPE_KEY_COLLECTION);
});

test("decideForScope: no offers is a no-op", () => {
  const decision = decideForScope(SCOPE_KEY_COLLECTION, [], undefined, NOW);
  assert.equal(decision.action, "none");
  assert.equal(decision.action === "none" && decision.reason, "no-offers");
});

test("selectHighestOffer: ignores unusable prices and tie-breaks stably by id", () => {
  assert.equal(selectHighestOffer([offer({ id: "z", priceNative: 0 }), offer({ id: "r", priceNative: 0.05 })])?.id, "r");
  const tied = [offer({ id: "zzz", priceNative: 0.3 }), offer({ id: "aaa", priceNative: 0.3 })];
  assert.equal(selectHighestOffer(tied)?.id, "aaa");
  assert.equal(selectHighestOffer([...tied].reverse())?.id, "aaa");
  assert.equal(selectHighestOffer([]), null);
});

// --- Record contents carried for display --------------------------------

test("an item record carries the tokenId; a trait record carries the trait", () => {
  const [itemDecision] = decideHighestOffers([offer({ id: "i", scope: "token", tokenId: "77", priceNative: 1 })], {}, NOW);
  assert.equal(itemDecision?.action === "baseline" && itemDecision.record.tokenId, "77");

  const [traitDecision] = decideHighestOffers(
    [offer({ id: "t", scope: "trait", trait: { key: "Background", value: "Blue" }, priceNative: 1 })],
    {},
    NOW,
  );
  assert.deepEqual(traitDecision?.action === "baseline" ? traitDecision.record.trait : undefined, { key: "Background", value: "Blue" });
});

test("describeScope: labels each scope distinctly", () => {
  assert.match(describeScope(record({ scope: "token", tokenId: "42" }), "Azuki"), /Item offer — Azuki #42/);
  assert.match(describeScope(record({ scope: "trait", trait: { key: "Background", value: "Blue" } }), "Azuki"), /Trait offer — Azuki · Background = Blue/);
  assert.match(describeScope(record({ scope: "collection" }), "Azuki"), /Collection offer — Azuki \(any item\)/);
});

test("describeDelta: reports the rise, and doesn't divide by zero", () => {
  assert.match(describeDelta(0.21, 0.18), /up from 0\.18/);
  assert.equal(describeDelta(0.2, 0), "first recorded high");
});

// --- Embed: image source + labelling per scope --------------------------

function embedFor(rec: HighestOfferRecord, prev: HighestOfferRecord) {
  return buildHighestOfferEmbed({
    collectionId: "0xabc",
    collectionName: "Azuki",
    collectionImageUrl: "https://img/collection.png",
    itemImageUrl: "https://img/item.png",
    record: rec,
    previous: prev,
    ethUsdRate: 2000,
  });
}

test("ITEM offer embed uses the ITEM image and names the token", () => {
  const embed = embedFor(record({ scope: "token", tokenId: "42", priceNative: 0.5, scopeKey: SCOPE_KEY_ITEM }), record({ priceNative: 0.3 }));

  assert.equal(embed.image, "https://img/item.png", "item offers must show the item's art");
  assert.equal(embed.thumbnail, undefined, "collection image must not be used for an item offer");
  assert.match(embed.title, /ITEM offer/);
  assert.match(embed.title, /#42/);
  assert.ok(embed.fields.some((f) => f.name === "Scope" && f.value.includes("#42")));
});

test("TRAIT offer embed uses the COLLECTION image and states the trait criteria", () => {
  const embed = embedFor(
    record({ scope: "trait", trait: { key: "Background", value: "Blue" }, priceNative: 0.5, scopeKey: "trait:Background=Blue" }),
    record({ priceNative: 0.3 }),
  );

  assert.equal(embed.thumbnail, "https://img/collection.png", "trait offers apply to many items — collection image");
  assert.equal(embed.image, undefined, "must not show one item's art for a trait offer");
  assert.match(embed.title, /TRAIT offer/);
  assert.match(embed.description ?? "", /Background = Blue/);
  assert.ok(embed.fields.some((f) => f.name === "Scope" && f.value.includes("Background = Blue")));
});

test("COLLECTION offer embed uses the COLLECTION image and says any item", () => {
  const embed = embedFor(record({ scope: "collection", priceNative: 0.5 }), record({ priceNative: 0.3 }));

  assert.equal(embed.thumbnail, "https://img/collection.png");
  assert.equal(embed.image, undefined);
  assert.match(embed.title, /COLLECTION offer/);
  assert.match(embed.description ?? "", /any item/i);
});

test("embed delta compares against the SAME scope's previous high", () => {
  const embed = embedFor(record({ scope: "collection", priceNative: 0.21 }), record({ priceNative: 0.18 }));
  assert.match(embed.description ?? "", /up from 0\.18/);
  assert.match(embed.description ?? "", /16\.7%/);
  assert.ok(embed.fields.some((f) => f.name === "Previous high (same scope)"));
});

test("an item offer with no decodable token id still renders without inventing one", () => {
  const embed = embedFor(record({ scope: "token", priceNative: 0.5, scopeKey: SCOPE_KEY_ITEM }), record({ priceNative: 0.3 }));
  assert.match(embed.title, /ITEM offer/);
  assert.doesNotMatch(embed.title, /#undefined/);
  assert.doesNotMatch(embed.fields.find((f) => f.name === "Scope")?.value ?? "", /undefined/);
});

// --- Store --------------------------------------------------------------

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "highest-offer-")), "highest.json");
}

test("HighestOfferStore: keeps scopes separate within a collection", () => {
  const store = new HighestOfferStore(tempPath());
  store.set("0xabc", SCOPE_KEY_COLLECTION, record({ priceNative: 0.1 }));
  store.set("0xabc", SCOPE_KEY_ITEM, record({ priceNative: 5, scope: "token", scopeKey: SCOPE_KEY_ITEM }));
  store.set("0xabc", "trait:Background=Blue", record({ priceNative: 0.2, scope: "trait", scopeKey: "trait:Background=Blue" }));

  assert.equal(store.get("0xabc", SCOPE_KEY_COLLECTION)?.priceNative, 0.1);
  assert.equal(store.get("0xabc", SCOPE_KEY_ITEM)?.priceNative, 5);
  assert.equal(store.get("0xABC", "trait:Background=Blue")?.priceNative, 0.2, "collection id lookup is case-insensitive");
  assert.equal(Object.keys(store.getForCollection("0xabc")).length, 3);
  assert.equal(store.size, 3);
});

test("HighestOfferStore: persists across instances", () => {
  const path = tempPath();
  new HighestOfferStore(path).set("0xabc", SCOPE_KEY_ITEM, record({ priceNative: 0.42, scope: "token", scopeKey: SCOPE_KEY_ITEM }));

  assert.equal(new HighestOfferStore(path).get("0xabc", SCOPE_KEY_ITEM)?.priceNative, 0.42);
});

test("HighestOfferStore: forget drops all of one collection's scopes", () => {
  const store = new HighestOfferStore(tempPath());
  store.set("0xabc", SCOPE_KEY_COLLECTION, record());
  store.set("0xabc", SCOPE_KEY_ITEM, record({ scope: "token", scopeKey: SCOPE_KEY_ITEM }));
  store.set("0xdef", SCOPE_KEY_COLLECTION, record());

  store.forget("0xabc");
  assert.deepEqual(store.getForCollection("0xabc"), {});
  assert.ok(store.get("0xdef", SCOPE_KEY_COLLECTION));
});

test("HighestOfferStore: a pre-per-scope file is dropped so it re-baselines instead of mis-filing", () => {
  // Old shape: collectionId -> record (no scope dimension). There's no
  // reliable way to know which market it belonged to.
  const path = tempPath();
  writeFileSync(path, JSON.stringify({ "0xabc": { offerId: "old", priceNative: 2.25, scope: "token" } }), "utf8");

  const store = new HighestOfferStore(path);
  assert.deepEqual(store.getForCollection("0xabc"), {});
  assert.equal(store.size, 0);
});

test("HighestOfferStore: corrupt file and malformed records degrade to empty", () => {
  const corrupt = tempPath();
  writeFileSync(corrupt, "not json", "utf8");
  assert.equal(new HighestOfferStore(corrupt).size, 0);

  const partial = tempPath();
  writeFileSync(partial, JSON.stringify({ "0xabc": { collection: { offerId: "x", priceNative: "lots" }, item: record({ priceNative: 1 }) } }), "utf8");
  const store = new HighestOfferStore(partial);
  assert.equal(store.get("0xabc", "collection"), undefined);
  assert.equal(store.get("0xabc", "item")?.priceNative, 1);
});
