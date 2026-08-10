import assert from "node:assert/strict";
import test from "node:test";
import type { ListingInfo } from "../types/index.js";
import { selectLowestListingPerToken } from "./lowestListing.js";

function makeListing(overrides: Partial<ListingInfo> = {}): ListingInfo {
  return {
    id: "order-1",
    collectionId: "0xabc",
    tokenId: "1",
    priceNative: 1,
    priceCurrency: "ETH",
    seller: "0xseller",
    source: "opensea",
    createdAt: "2026-08-10T00:00:00Z",
    ...overrides,
  };
}

test("selectLowestListingPerToken: passes through one listing per token untouched", () => {
  const listings = [makeListing({ id: "a", tokenId: "1" }), makeListing({ id: "b", tokenId: "2" })];
  const result = selectLowestListingPerToken(listings);

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((l) => l.id).sort(), ["a", "b"]);
});

test("selectLowestListingPerToken: keeps only the cheapest order for a token", () => {
  const listings = [
    makeListing({ id: "expensive", tokenId: "327", priceNative: 0.189656 }),
    makeListing({ id: "cheap", tokenId: "327", priceNative: 0.189645 }),
  ];
  const result = selectLowestListingPerToken(listings);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "cheap");
  assert.equal(result[0]!.priceNative, 0.189645);
});

test("selectLowestListingPerToken: order of input doesn't change the winner", () => {
  const cheap = makeListing({ id: "cheap", tokenId: "327", priceNative: 0.189645 });
  const dear = makeListing({ id: "dear", tokenId: "327", priceNative: 0.189656 });

  assert.equal(selectLowestListingPerToken([cheap, dear])[0]!.id, "cheap");
  assert.equal(selectLowestListingPerToken([dear, cheap])[0]!.id, "cheap");
});

test("selectLowestListingPerToken: reproduces the real Super Punk World #327 flip-flop case", () => {
  // The exact live data that caused the ▼▲▼▲ alternation: #327 listed twice
  // at near-identical prices, plus another token in the same response.
  const listings = [
    makeListing({ id: "hash-a", tokenId: "327", priceNative: 0.189645 }),
    makeListing({ id: "hash-b", tokenId: "488", priceNative: 0.18964599 }),
    makeListing({ id: "hash-c", tokenId: "327", priceNative: 0.189656 }),
  ];

  const result = selectLowestListingPerToken(listings);
  const byToken = new Map(result.map((l) => [l.tokenId, l]));

  assert.equal(result.length, 2, "each token must appear exactly once");
  assert.equal(byToken.get("327")!.priceNative, 0.189645, "#327 must settle on its cheapest order");
  assert.equal(byToken.get("488")!.priceNative, 0.18964599);
});

test("selectLowestListingPerToken: repeated calls are stable, so the anchor can't oscillate", () => {
  // The actual regression guard: feeding the same multi-listing response
  // across successive ticks must yield an identical choice every time.
  const listings = [
    makeListing({ id: "hash-c", tokenId: "327", priceNative: 0.189656 }),
    makeListing({ id: "hash-a", tokenId: "327", priceNative: 0.189645 }),
  ];

  const picks = new Set<string>();
  for (let tick = 0; tick < 25; tick++) {
    picks.add(`${selectLowestListingPerToken(listings)[0]!.id}@${selectLowestListingPerToken(listings)[0]!.priceNative}`);
  }
  assert.equal(picks.size, 1, `expected one stable choice across ticks, got: ${[...picks].join(", ")}`);
  assert.equal([...picks][0], "hash-a@0.189645");
});

test("selectLowestListingPerToken: ties break deterministically by id", () => {
  const listings = [
    makeListing({ id: "zzz", tokenId: "5", priceNative: 0.5 }),
    makeListing({ id: "aaa", tokenId: "5", priceNative: 0.5 }),
  ];
  assert.equal(selectLowestListingPerToken(listings)[0]!.id, "aaa");
  // ...and independent of input order.
  assert.equal(selectLowestListingPerToken([...listings].reverse())[0]!.id, "aaa");
});

test("selectLowestListingPerToken: a cheaper new order replaces the previous cheapest", () => {
  const before = selectLowestListingPerToken([makeListing({ id: "a", tokenId: "1", priceNative: 0.5 })]);
  assert.equal(before[0]!.priceNative, 0.5);

  const after = selectLowestListingPerToken([
    makeListing({ id: "a", tokenId: "1", priceNative: 0.5 }),
    makeListing({ id: "b", tokenId: "1", priceNative: 0.3 }),
  ]);
  assert.equal(after[0]!.priceNative, 0.3, "a genuinely cheaper listing must win — real price drops still surface");
});

test("selectLowestListingPerToken: empty input yields empty output", () => {
  assert.deepEqual(selectLowestListingPerToken([]), []);
});

test("selectLowestListingPerToken: preserves the full listing object, not just the price", () => {
  const listings = [makeListing({ id: "win", tokenId: "1", priceNative: 0.2, seller: "0xalice", rank: 42 })];
  const [result] = selectLowestListingPerToken(listings);

  assert.equal(result!.seller, "0xalice");
  assert.equal(result!.rank, 42);
  assert.equal(result!.collectionId, "0xabc");
});
