import assert from "node:assert/strict";
import { test } from "node:test";
import type { Alert, CollectionOfferInfo, DryRunResult, SaleInfo } from "../types/index.js";
import type { BidLeadCandidate } from "../watchlist/candidate.js";
import type { WatchlistMatch } from "../watchlist/evaluate.js";
import type { AllowlistEntry } from "../watchlist/schema.js";
import {
  applyLeadDecision,
  buildAddPreviewEmbed,
  buildAlertEmbed,
  buildBidLeadEmbed,
  buildDryRunResultEmbed,
  buildListingStatusEmbed,
  buildOffersEmbed,
  buildSaleEmbed,
  buildStatusEmbed,
  toDiscordEmbed,
  type EmbedContent,
  type StatusInfo,
} from "./embeds.js";

function makeCandidate(overrides: Partial<BidLeadCandidate> = {}): BidLeadCandidate {
  return {
    collectionId: "0xcollection",
    collectionName: "Test Collection",
    tokenId: "42",
    priceNative: 1.5,
    priceCurrency: "ETH",
    floorPriceNative: 1.8,
    percentFromFloor: -16.7,
    source: "opensea",
    listingId: "listing-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    id: "entry-1",
    label: "Blue chip sweep",
    enabled: true,
    priorityTier: "blue-chip",
    collection: "0xcollection",
    filters: {},
    muted: false,
    dedupeWindowMinutes: 30,
    rateLimitPerHour: 10,
    ...overrides,
  };
}

test("buildBidLeadEmbed: includes collection/token, price context, and reasoning", () => {
  const candidate = makeCandidate({ trait: { key: "Headwear", value: "Crown" }, rankPercentile: 4.2 });
  const match: WatchlistMatch = { entry: makeEntry(), reasoning: ["Priced under target", "Rare trait match"] };

  const embed = buildBidLeadEmbed(candidate, match);

  assert.match(embed.title, /Test Collection/);
  assert.match(embed.title, /#42/);
  assert.match(embed.description ?? "", /Priced under target/);
  assert.match(embed.description ?? "", /Rare trait match/);
  assert.ok(embed.fields.some((f) => f.name === "Price" && f.value.includes("1.5")));
  assert.ok(embed.fields.some((f) => f.name === "Trait" && f.value.includes("Crown")));
  assert.ok(embed.fields.some((f) => f.name === "Rarity"));
  assert.ok(embed.fields.some((f) => f.name === "Watchlist entry" && f.value.includes("Blue chip sweep")));
  assert.match(embed.footer ?? "", /buttons/i);
  assert.match(embed.footer ?? "", /✅❌👀/);
  assert.ok(embed.fields.some((f) => f.name === "Links" && f.value.includes("OpenSea")));
});

test("buildBidLeadEmbed: carries the candidate's image through to the embed, and omits it when unavailable", () => {
  const withImage = buildBidLeadEmbed(makeCandidate({ imageUrl: "https://example.com/nft.png" }), {
    entry: makeEntry(),
    reasoning: [],
  });
  assert.equal(withImage.image, "https://example.com/nft.png");

  const withoutImage = buildBidLeadEmbed(makeCandidate(), { entry: makeEntry(), reasoning: [] });
  assert.equal(withoutImage.image, undefined);
});

test("buildDryRunResultEmbed: makes the dry-run/no-signing notice explicit", () => {
  const result: DryRunResult = {
    dryRun: true,
    action: "buy",
    summary: "Buy token 42 from collection 0xcollection",
    params: {},
    estimatedGasUnits: 150000,
    estimatedGasCostNative: 0.003,
    gasCurrency: "ETH",
    wouldSubmitTo: "OpenSea Seaport fulfillment (fulfill_listing) (NOT called — dry-run only)",
    timestamp: new Date().toISOString(),
  };

  const embed = buildDryRunResultEmbed(result);

  assert.match(embed.title, /buy/);
  assert.equal(embed.description, result.summary);
  assert.ok(embed.fields.some((f) => f.value.includes("150000")));
  assert.ok(embed.fields.some((f) => f.value.includes("NOT called")));
  assert.match(embed.footer ?? "", /DRY-RUN ONLY/);
  assert.match(embed.footer ?? "", /nothing was signed or broadcast/i);
});

test("buildAlertEmbed: severity maps to a distinct color and data fields are flattened", () => {
  const warning: Alert = {
    title: "Floor price moved up — Doodles",
    message: "Doodles floor moved 5% from 2.0 to 2.1 ETH.",
    severity: "warning",
    data: { previousFloor: 2.0, newFloor: 2.1 },
    kind: "floor-move",
  };
  const info: Alert = {
    title: "New low-priced listing — Doodles",
    message: "Token 5 listed for 1.5 ETH.",
    severity: "info",
    kind: "new-listing",
  };

  const warningEmbed = buildAlertEmbed(warning);
  const infoEmbed = buildAlertEmbed(info);

  assert.notEqual(warningEmbed.color, infoEmbed.color);
  assert.equal(warningEmbed.fields.length, 2);
  assert.ok(warningEmbed.fields.some((f) => f.name === "previousFloor"));
  assert.equal(infoEmbed.fields.length, 0);
});

test("buildAlertEmbed: new-listing alerts carry an image, trend/floor-move alerts carry a thumbnail", () => {
  const newListing: Alert = {
    title: "New listing",
    message: "Token 5 listed.",
    severity: "info",
    kind: "new-listing",
    imageUrl: "https://example.com/token.png",
  };
  const trendMove: Alert = {
    title: "Floor moved",
    message: "Floor moved.",
    severity: "warning",
    kind: "floor-move",
    thumbnailUrl: "https://example.com/collection.png",
  };

  const newListingEmbed = buildAlertEmbed(newListing);
  const trendMoveEmbed = buildAlertEmbed(trendMove);

  assert.equal(newListingEmbed.image, "https://example.com/token.png");
  assert.equal(newListingEmbed.thumbnail, undefined);
  assert.equal(trendMoveEmbed.thumbnail, "https://example.com/collection.png");
  assert.equal(trendMoveEmbed.image, undefined);
});

test("buildAlertEmbed: carries the alert's timestamp through, and price-change severity maps to the warning color", () => {
  const now = new Date().toISOString();
  const priceChange: Alert = {
    title: "▲ Price change — Test Collection #5",
    message: "Token 5 relisted at 0.3 ETH (was 0.2 ETH, ▲ 50.0%).",
    severity: "warning",
    kind: "price-change",
    timestamp: now,
  };

  const embed = buildAlertEmbed(priceChange);
  assert.equal(embed.timestamp, now);

  const withoutTimestamp = buildAlertEmbed({ title: "x", message: "y", severity: "info" });
  assert.equal(withoutTimestamp.timestamp, undefined);
});

test("toDiscordEmbed: sets the discord.js embed's native timestamp when provided", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  const embed = toDiscordEmbed({
    title: "Test",
    color: 0x123456,
    fields: [],
    timestamp: now.toISOString(),
  });
  assert.equal(embed.toJSON().timestamp, now.toISOString());
});

function makeOffer(overrides: Partial<CollectionOfferInfo> = {}): CollectionOfferInfo {
  return {
    id: "offer-1",
    collectionId: "0xcollection",
    priceNative: 0.3,
    priceCurrency: "ETH",
    bidder: "0xbidder",
    source: "opensea",
    createdAt: new Date().toISOString(),
    scope: "collection",
    ...overrides,
  };
}

test("buildOffersEmbed: highlights the top collection-wide offer and labels each offer's scope", () => {
  const offers = [
    makeOffer({ id: "c1", priceNative: 0.3, scope: "collection" }),
    makeOffer({ id: "c2", priceNative: 0.5, scope: "collection" }),
    makeOffer({ id: "t1", priceNative: 0.9, scope: "trait", trait: { key: "Background", value: "Blue" } }),
  ];

  const embed = buildOffersEmbed("Test Collection", offers, "https://example.com/thumb.png");

  assert.match(embed.description ?? "", /Top collection offer.*0\.5/);
  assert.equal(embed.thumbnail, "https://example.com/thumb.png");
  assert.ok(embed.fields.some((f) => f.name.includes("collection-wide")));
  assert.ok(embed.fields.some((f) => f.name.includes("Background: Blue")));
});

test("buildOffersEmbed: omits the top-offer line when there are no collection-wide offers", () => {
  const offers = [makeOffer({ scope: "trait", trait: { key: "Eyes", value: "Laser" } })];
  const embed = buildOffersEmbed("Test Collection", offers);
  assert.equal(embed.description, undefined);
});

test("buildOffersEmbed: reports no active offers found when the list is empty", () => {
  const embed = buildOffersEmbed("Test Collection", []);
  assert.match(embed.description ?? "", /No active offers/);
  assert.equal(embed.fields.length, 0);
});

function makeSale(overrides: Partial<SaleInfo> = {}): SaleInfo {
  return {
    id: "0xtxhash:42",
    collectionId: "0xcollection",
    tokenId: "42",
    priceNative: 0.5,
    priceCurrency: "ETH",
    buyer: "0xbuyer00000000000000000000000000000000",
    seller: "0xseller0000000000000000000000000000000",
    source: "opensea",
    createdAt: new Date().toISOString(),
    transactionHash: "0xtxhash",
    ...overrides,
  };
}

test("buildSaleEmbed: includes price, buyer/seller, marketplace, and image", () => {
  const sale = makeSale({ imageUrl: "https://example.com/nft.png" });
  const embed = buildSaleEmbed(sale, "Test Collection");

  assert.match(embed.title, /Test Collection/);
  assert.match(embed.title, /#42/);
  assert.ok(embed.fields.some((f) => f.name === "Price" && f.value.includes("0.5 ETH")));
  assert.ok(embed.fields.some((f) => f.name === "Buyer" && f.value.startsWith("0xbuye")));
  assert.ok(embed.fields.some((f) => f.name === "Seller" && f.value.startsWith("0xsell")));
  assert.ok(embed.fields.some((f) => f.name === "Marketplace" && f.value === "opensea"));
  assert.equal(embed.image, "https://example.com/nft.png");
  assert.match(embed.footer ?? "", /0xtxhash/);
});

test("buildSaleEmbed: shows a USD estimate only when the sale carries one", () => {
  const withUsd = buildSaleEmbed(makeSale({ priceCurrency: "USDC", priceNative: 250, priceUsd: 250 }), "Test Collection");
  assert.match(withUsd.description ?? "", /\$250\b/);

  const withoutUsd = buildSaleEmbed(makeSale(), "Test Collection");
  assert.doesNotMatch(withoutUsd.description ?? "", /\$/);
});

test("toDiscordEmbed: converts plain embed content into a discord.js EmbedBuilder without throwing", () => {
  const embed = toDiscordEmbed({
    title: "Test",
    description: "Description",
    color: 0x123456,
    fields: [{ name: "A", value: "B", inline: true }],
    footer: "Footer text",
  });

  const json = embed.toJSON();
  assert.equal(json.title, "Test");
  assert.equal(json.description, "Description");
  assert.equal(json.color, 0x123456);
  assert.equal(json.fields?.[0]?.name, "A");
  assert.equal(json.footer?.text, "Footer text");
});

test("buildAddPreviewEmbed: shows floor/owners/volume when a floor reading is available", () => {
  const resolved = { address: "0xabc0000000000000000000000000000000abc0", slug: "test-collection", name: "Test Collection" };
  const floor = { id: "0xabc", name: "Test Collection", floorPriceNative: 0.5, floorPriceCurrency: "ETH", chain: "ethereum", owners: 100, volume24hNative: 12.3 };

  const embed = buildAddPreviewEmbed(resolved, floor, "https://example.com/thumb.png");

  assert.match(embed.title, /Add to watchlist\?/);
  assert.match(embed.title, /Test Collection/);
  assert.ok(embed.fields.some((f) => f.name === "Floor" && f.value.includes("0.5")));
  assert.ok(embed.fields.some((f) => f.name === "Owners" && f.value === "100"));
  assert.ok(embed.fields.some((f) => f.name === "24h volume"));
  assert.equal(embed.thumbnail, "https://example.com/thumb.png");
});

test("buildAddPreviewEmbed: shows an 'unavailable' floor when the floor reading failed, without throwing", () => {
  const resolved = { address: "0xabc0000000000000000000000000000000abc0", slug: "test-collection", name: "Test Collection" };
  const embed = buildAddPreviewEmbed(resolved, null);
  assert.ok(embed.fields.some((f) => f.name === "Floor" && f.value === "unavailable"));
});

test("buildListingStatusEmbed: includes the image, price, and seen count", () => {
  const embed = buildListingStatusEmbed({
    collectionName: "Test Collection",
    tokenId: "42",
    priceNative: 0.25,
    priceCurrency: "ETH",
    imageUrl: "https://example.com/nft.png",
    seenCount: 3,
    lastSeenAt: new Date().toISOString(),
  });

  assert.match(embed.title, /Still listed/);
  assert.match(embed.title, /Test Collection #42/);
  assert.match(embed.description ?? "", /0\.25 ETH/);
  assert.match(embed.description ?? "", /seen 3×/);
  assert.equal(embed.image, "https://example.com/nft.png");
});

test("buildListingStatusEmbed: omits the image when unavailable, without throwing", () => {
  const embed = buildListingStatusEmbed({
    collectionName: "Test Collection",
    tokenId: "42",
    priceNative: 0.25,
    priceCurrency: "ETH",
    seenCount: 2,
    lastSeenAt: new Date().toISOString(),
  });
  assert.equal(embed.image, undefined);
});

function makeBidLeadEmbed(): EmbedContent {
  const candidate = makeCandidate();
  const match: WatchlistMatch = { entry: makeEntry(), reasoning: ["Priced under target"] };
  return buildBidLeadEmbed(candidate, match);
}

test("applyLeadDecision: accepted badges the title, keeps the description readable, and uses the accept color", () => {
  const original = makeBidLeadEmbed();
  const updated = applyLeadDecision(original, "accepted", "dry-run order built");

  assert.match(updated.title, /^✅ ACCEPTED — /);
  assert.match(updated.title, /Test Collection/);
  assert.equal(updated.description, original.description, "accepted must not strike through the description");
  assert.notEqual(updated.color, original.color);
  assert.match(updated.footer ?? "", /dry-run order built/);
});

test("applyLeadDecision: denied badges the title, strikes through every non-blank description line, and uses a muted color", () => {
  const original = makeBidLeadEmbed();
  const updated = applyLeadDecision(original, "denied");

  assert.match(updated.title, /^❌ DENIED — /);
  for (const line of (updated.description ?? "").split("\n")) {
    if (line.trim()) assert.match(line, /^~~.*~~$/);
  }
  assert.notEqual(updated.color, original.color);
});

test("applyLeadDecision: watching badges the title without striking through the description", () => {
  const original = makeBidLeadEmbed();
  const updated = applyLeadDecision(original, "watching");

  assert.match(updated.title, /^👀 WATCHING — /);
  assert.equal(updated.description, original.description);
});

test("buildBidLeadEmbed: shows a friendly floor-delta tag, rarity rank, last sale, and quick links", () => {
  const candidate = makeCandidate({
    percentFromFloor: -16.7,
    rank: 234,
    rankPercentile: 4.2,
    lastSalePriceNative: 1.2,
    lastSalePriceCurrency: "ETH",
    sellerWallet: "0xsellerabc0000000000000000000000000000000",
  });
  const match: WatchlistMatch = { entry: makeEntry(), reasoning: ["test"] };

  const embed = buildBidLeadEmbed(candidate, match);

  const floorField = embed.fields.find((f) => f.name === "vs floor");
  assert.match(floorField?.value ?? "", /below floor/);
  const rarityField = embed.fields.find((f) => f.name === "Rarity");
  assert.match(rarityField?.value ?? "", /#234/);
  assert.match(rarityField?.value ?? "", /4\.2%/);
  const lastSaleField = embed.fields.find((f) => f.name === "Last sale");
  assert.match(lastSaleField?.value ?? "", /1\.2 ETH/);
  const linksField = embed.fields.find((f) => f.name === "Links");
  assert.match(linksField?.value ?? "", /opensea\.io/);
  assert.match(linksField?.value ?? "", /etherscan\.io/);
  assert.match(linksField?.value ?? "", /seller/i);
});

test("buildBidLeadEmbed: omits last-sale and seller-link when unavailable, without throwing", () => {
  const candidate = makeCandidate();
  const match: WatchlistMatch = { entry: makeEntry(), reasoning: ["test"] };

  const embed = buildBidLeadEmbed(candidate, match);

  assert.equal(embed.fields.some((f) => f.name === "Last sale"), false);
  const linksField = embed.fields.find((f) => f.name === "Links");
  assert.doesNotMatch(linksField?.value ?? "", /seller/i);
});

function makeStatus(overrides: Partial<StatusInfo> = {}): StatusInfo {
  return {
    dryRun: true,
    hasOpenSeaKey: true,
    watchlistCount: 2,
    discordWebhookEnabled: false,
    nextTrendCheckAt: new Date(),
    pollIntervalSeconds: 3600,
    trendAlertTimes: "08:00,20:00",
    uptimeSeconds: 3725,
    lastPollAt: new Date().toISOString(),
    lastTrendCheckAt: null,
    rateLimitHealth: { requestsInLastMinute: 12, budgetPerMinute: 50, queueLength: 0, recent429Count: 0 },
    activitySummary: [],
    watchedItemCount: 0,
    whaleCount: 0,
    lastRecapAt: null,
    nextRecapAt: new Date(),
    chartsEnabled: true,
    portfolioAddress: null,
    portfolioEnsName: null,
    ...overrides,
  };
}

test("buildStatusEmbed: shows uptime, last poll/trend check, rate-limit health, and per-collection activity", () => {
  const status = makeStatus({
    activitySummary: [
      { label: "Super Punk World", listings: 3, sales: 1, leads: 2 },
      { label: "RTFKT Project Animus", listings: 0, sales: 0, leads: 0 },
    ],
  });

  const embed = buildStatusEmbed(status);

  assert.ok(embed.fields.some((f) => f.name === "Uptime" && f.value === "1h 2m"));
  assert.ok(embed.fields.some((f) => f.name === "Last poll" && f.value === "just now"));
  assert.ok(embed.fields.some((f) => f.name === "Last trend check" && f.value === "never"));
  assert.ok(embed.fields.some((f) => f.name === "OpenSea rate limit" && f.value.includes("12/50 req/min")));
  const activityField = embed.fields.find((f) => f.name === "Activity since startup");
  assert.match(activityField?.value ?? "", /Super Punk World/);
  assert.match(activityField?.value ?? "", /3 listings, 1 sale, 2 leads/);
});

test("buildStatusEmbed: omits the activity field entirely when there's nothing to show yet", () => {
  const embed = buildStatusEmbed(makeStatus({ activitySummary: [] }));
  assert.equal(embed.fields.some((f) => f.name === "Activity since startup"), false);
});
