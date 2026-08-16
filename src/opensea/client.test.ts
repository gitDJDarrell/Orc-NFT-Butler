import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSingleTokenId, formatPriceWithUsd, OpenSeaClient, targetsSpecificTokens } from "./client.js";

/**
 * Stubs global.fetch so a fresh OpenSeaClient (which has a real API key
 * configured in this project's .env, so `usingMockData` is false) resolves
 * the slug lookup successfully but gets the given status/body for the
 * actual data call — simulating exactly the rate-limit failure mode from
 * the real #watchlist-sales incident. Restores the original fetch after.
 */
async function withStubbedFetch<T>(dataCallStatus: number, dataCallBody: unknown, run: (client: OpenSeaClient) => Promise<T>): Promise<T> {
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/chain/") && href.includes("/contract/")) {
      return new Response(JSON.stringify({ collection: "test-collection", name: "Test Collection" }), { status: 200 });
    }
    return new Response(JSON.stringify(dataCallBody), { status: dataCallStatus, statusText: "stubbed" });
  }) as typeof fetch;

  try {
    return await run(new OpenSeaClient());
  } finally {
    global.fetch = originalFetch;
  }
}

test("getRecentSales: never fabricates a sale on a live failure (regression for the #watchlist-sales incident: a 429 used to silently post a mock sale with a stock-photo image under the real collectionId)", async () => {
  const sales = await withStubbedFetch(429, { errors: ["Rate limit exceeded"] }, (client) => client.getRecentSales("0xTestAddress", 10));
  assert.deepEqual(sales, []);
});

test("getRecentListings: never fabricates listings on a live failure", async () => {
  const listings = await withStubbedFetch(429, { errors: ["Rate limit exceeded"] }, (client) => client.getRecentListings("0xTestAddress", 10));
  assert.deepEqual(listings, []);
});

test("getFloorPrice: never fabricates a floor reading on a live failure - throws so the caller's existing per-tick try/catch skips and retries", async () => {
  await assert.rejects(() => withStubbedFetch(429, { errors: ["Rate limit exceeded"] }, (client) => client.getFloorPrice("0xTestAddress")));
});

test("formatPriceWithUsd: computes USD from the live rate for ETH", () => {
  assert.equal(formatPriceWithUsd(0.25, "ETH", { ethUsdRate: 3369.68 }), "0.25 ETH (~$842)");
});

test("formatPriceWithUsd: treats WETH as ETH-pegged too", () => {
  assert.equal(formatPriceWithUsd(1, "WETH", { ethUsdRate: 2000 }), "1 WETH (~$2,000)");
});

test("formatPriceWithUsd: rounds to whole dollars at $10+, one decimal below $10", () => {
  assert.equal(formatPriceWithUsd(0.001, "ETH", { ethUsdRate: 3000 }), "0.001 ETH (~$3.0)");
  assert.equal(formatPriceWithUsd(1, "ETH", { ethUsdRate: 3000 }), "1 ETH (~$3,000)");
});

test("formatPriceWithUsd: no rate available shows ETH only, never fabricates a figure", () => {
  assert.equal(formatPriceWithUsd(0.25, "ETH", {}), "0.25 ETH");
  assert.equal(formatPriceWithUsd(0.25, "ETH", { ethUsdRate: undefined }), "0.25 ETH");
});

test("formatPriceWithUsd: non-ETH-pegged currencies with no knownUsd show native only", () => {
  assert.equal(formatPriceWithUsd(100, "USDC", { ethUsdRate: 3000 }), "100 USDC");
});

test("formatPriceWithUsd: knownUsd (e.g. a stablecoin sale) takes priority over a computed ETH rate", () => {
  assert.equal(formatPriceWithUsd(250, "USDC", { knownUsd: 250, ethUsdRate: 3000 }), "250 USDC (~$250)");
});

// --- Offer scope classification (regression: "*" is collection-wide) ----

test("targetsSpecificTokens: the '*' wildcard means ANY item, not a specific token", () => {
  // Confirmed live: OpenSea sends encoded_token_ids:"*" on every
  // collection-wide offer. Treating presence as truthy misclassified all of
  // them as item offers, which also left the above-market-offer check inert
  // (it filters on scope === "collection" and found none).
  assert.equal(targetsSpecificTokens("*"), false);
  assert.equal(targetsSpecificTokens(" * "), false);
  assert.equal(targetsSpecificTokens(""), false);
  assert.equal(targetsSpecificTokens(undefined), false);
});

test("targetsSpecificTokens: a concrete id or set does target specific tokens", () => {
  assert.equal(targetsSpecificTokens("1234"), true);
  assert.equal(targetsSpecificTokens("1,2,3"), true);
  assert.equal(targetsSpecificTokens("1:100"), true);
});

test("decodeSingleTokenId: only an unambiguous single id yields a token id", () => {
  assert.equal(decodeSingleTokenId("1234"), "1234");
  assert.equal(decodeSingleTokenId(" 42 "), "42");
  // A wildcard, list, or range must NOT name one arbitrary token.
  assert.equal(decodeSingleTokenId("*"), undefined);
  assert.equal(decodeSingleTokenId("1,2,3"), undefined);
  assert.equal(decodeSingleTokenId("1:100"), undefined);
  assert.equal(decodeSingleTokenId(undefined), undefined);
});
