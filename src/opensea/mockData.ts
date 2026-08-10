import type { BidInfo, CollectionInfo, CollectionOfferInfo, CollectionSearchResult, ListingInfo, SaleInfo, Trait, TraitCategory } from "../types/index.js";

/**
 * Deterministic-ish mock data used when no OPENSEA_API_KEY is configured,
 * so the whole agent (monitor, notify, order intake, bid-lead evaluation)
 * can be exercised without any external credentials.
 */

const MOCK_COLLECTIONS: Record<string, { name: string; basePrice: number; volume24h: number; owners: number; listingsCount: number }> = {
  "0x5af0d9827e0c53e4799bb226655a1de152a425a": {
    name: "Doodles (mock)",
    basePrice: 2.1,
    volume24h: 45.2,
    owners: 4800,
    listingsCount: 620,
  },
  "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13": {
    name: "Mutant Ape Yacht Club (mock)",
    basePrice: 8.4,
    volume24h: 120.7,
    owners: 12400,
    listingsCount: 1450,
  },
  "0xed5af388653567af2f388e6224dc7c4b3241c544": {
    name: "Azuki (mock)",
    basePrice: 3.7,
    volume24h: 61.5,
    owners: 5300,
    listingsCount: 780,
  },
};

const DEFAULT_MOCK_IDS = Object.keys(MOCK_COLLECTIONS);

/** Small shared pool of example traits so listings can exercise the trait-floor watchlist filter. */
const MOCK_TRAITS: Trait[] = [
  { key: "Background", value: "Blue" },
  { key: "Headwear", value: "Crown" },
  { key: "Eyes", value: "Laser" },
  { key: "Fur", value: "Golden" },
];

/** Mock trait catalog (categories + values), same shape /traits/{slug} returns — used for trait autocomplete in mock mode, deterministic and identical across collections. */
const MOCK_TRAIT_CATEGORIES: TraitCategory[] = [
  { key: "Background", values: ["Blue", "Red", "Green", "Purple"] },
  { key: "Headwear", values: ["Crown", "Cap", "Bandana", "None"] },
  { key: "Eyes", values: ["Laser", "Normal", "Sleepy", "Wink"] },
  { key: "Fur", values: ["Golden", "Brown", "White", "Black"] },
];

let mockTick = 0;

function mockCollectionFor(id: string) {
  return (
    MOCK_COLLECTIONS[id.toLowerCase()] ?? {
      name: `Unknown collection ${id.slice(0, 8)}… (mock)`,
      basePrice: 1.0,
      volume24h: 5,
      owners: 500,
      listingsCount: 80,
    }
  );
}

/** Floor price drifts slightly each call so trend detection has something to detect. */
export function mockFloorPrice(collectionId: string): CollectionInfo {
  const base = mockCollectionFor(collectionId);
  const wobble = Math.sin((mockTick += 1) / 3) * 0.08 + (Math.random() - 0.5) * 0.02;
  const price = Math.max(0.01, base.basePrice * (1 + wobble));
  return {
    id: collectionId,
    name: base.name,
    floorPriceNative: Number(price.toFixed(4)),
    floorPriceCurrency: "ETH",
    chain: "ethereum",
    volume24hNative: Number((base.volume24h * (0.85 + Math.random() * 0.3)).toFixed(2)),
    owners: base.owners,
    listingsCount: base.listingsCount,
  };
}

export function mockDefaultCollections(): string[] {
  return DEFAULT_MOCK_IDS;
}

/**
 * Mock-mode equivalent of OpenSeaClient.resolveCollection(): a 0x address
 * always "resolves" (matching mockCollectionFor's own always-succeeds
 * fallback), while a name/slug only resolves if it matches one of the known
 * mock collections — an unrecognized name honestly fails to resolve here
 * too, same as it would against the live API.
 */
export function mockResolveCollection(input: string): { address: string; slug: string; name: string } | null {
  const trimmed = input.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    const address = trimmed.toLowerCase();
    return { address, slug: address, name: mockCollectionFor(address).name };
  }

  const lower = trimmed.toLowerCase();
  for (const [address, info] of Object.entries(MOCK_COLLECTIONS)) {
    const bareName = info.name.replace(/\s*\(mock\)\s*$/i, "").toLowerCase();
    if (bareName === lower || bareName.includes(lower) || lower.includes(bareName)) {
      return { address, slug: address, name: info.name };
    }
  }
  return null;
}

export function mockRecentListings(collectionId: string, limit = 5): ListingInfo[] {
  const base = mockCollectionFor(collectionId);
  return Array.from({ length: limit }, (_, i) => {
    const price = base.basePrice * (0.6 + Math.random() * 0.6);
    const rank = Math.floor(Math.random() * 9999) + 1;
    return {
      // Deliberately NOT time-based: real listing IDs (order hashes) are
      // stable across polls, and CollectionMonitor/BidLeadMonitor dedupe
      // "new" listings by ID. A Date.now()-based ID here would make every
      // mock listing look "new" on every single poll forever, defeating
      // dedupe/rate-limiting and flooding Discord — this caused a real
      // incident (see the "infinite updates" fix in monitor/index.ts and
      // discord-bot/client.ts's allowlist gate).
      id: `mock-listing-${collectionId.slice(2, 8)}-${i}`,
      collectionId,
      tokenId: String(Math.floor(Math.random() * 9999)),
      priceNative: Number(price.toFixed(4)),
      priceCurrency: "ETH",
      seller: `0xmock${i.toString().padStart(4, "0")}`,
      // OpenSea is now the only marketplace we query directly (no more
      // cross-marketplace aggregation), so mock listings are labeled the
      // same way live ones would be.
      source: "opensea",
      createdAt: new Date(Date.now() - i * 60_000).toISOString(),
      // About 1 in 4 listings carries a notable trait, matching real-world rarity distribution loosely.
      trait: i % 4 === 0 ? MOCK_TRAITS[i % MOCK_TRAITS.length] : undefined,
      rank,
      rankPercentile: Number(((rank / 10000) * 100).toFixed(2)),
    };
  });
}

export function mockRecentBids(collectionId: string, limit = 5): BidInfo[] {
  const base = mockCollectionFor(collectionId);
  return Array.from({ length: limit }, (_, i) => {
    const price = base.basePrice * (0.4 + Math.random() * 0.4);
    return {
      // Same rationale as mockRecentListings — stable ID, no Date.now().
      id: `mock-bid-${collectionId.slice(2, 8)}-${i}`,
      collectionId,
      priceNative: Number(price.toFixed(4)),
      priceCurrency: "ETH",
      bidder: `0xmockbidder${i.toString().padStart(3, "0")}`,
      source: "opensea-mock",
      createdAt: new Date(Date.now() - i * 90_000).toISOString(),
    };
  });
}

/**
 * Deterministic placeholder image, seeded off the collection+token so the
 * same NFT always renders the same picture across polls. picsum.photos URLs
 * are safe to hand straight to Discord even in mock mode — the server never
 * fetches them itself, only Discord's client does when rendering the embed.
 */
export function mockNftImage(collectionId: string, tokenId: string): string {
  const seed = `${collectionId.slice(2, 10)}-${tokenId}`;
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/400/400`;
}

/** Image + a deterministic subset of the mock trait pool, mirroring what OpenSeaClient.getNftDetails returns live. */
export function mockNftDetails(collectionId: string, tokenId: string): { imageUrl?: string; traits: Trait[] } {
  const numericTokenId = Number(tokenId);
  const seed = Number.isFinite(numericTokenId) ? numericTokenId : tokenId.length;
  return {
    imageUrl: mockNftImage(collectionId, tokenId),
    traits: [MOCK_TRAITS[seed % MOCK_TRAITS.length]!, MOCK_TRAITS[(seed + 1) % MOCK_TRAITS.length]!],
  };
}

/** Substring match against the known mock collections' names — same "honestly fails to match" posture as mockResolveCollection. */
export function mockSearchCollections(query: string, limit = 10): CollectionSearchResult[] {
  const lower = query.trim().toLowerCase();
  const matches = Object.entries(MOCK_COLLECTIONS)
    .filter(([, info]) => info.name.replace(/\s*\(mock\)\s*$/i, "").toLowerCase().includes(lower))
    .map(([address, info]) => ({ slug: address, name: info.name, imageUrl: mockCollectionImage(address).imageUrl }));
  return matches.slice(0, limit);
}

export function mockTrendingCollections(limit = 10): CollectionSearchResult[] {
  return Object.entries(MOCK_COLLECTIONS)
    .map(([address, info]) => ({ slug: address, name: info.name, imageUrl: mockCollectionImage(address).imageUrl }))
    .slice(0, limit);
}

export function mockCollectionTraits(_collectionIdOrSlug: string): TraitCategory[] {
  return MOCK_TRAIT_CATEGORIES;
}

export function mockCollectionImage(collectionId: string): { imageUrl?: string; bannerImageUrl?: string } {
  const seed = collectionId.slice(2, 10) || collectionId;
  return {
    imageUrl: `https://picsum.photos/seed/${encodeURIComponent(seed)}-icon/200/200`,
    bannerImageUrl: `https://picsum.photos/seed/${encodeURIComponent(seed)}-banner/800/200`,
  };
}

/**
 * A handful of collection/trait-scoped offers. Always includes one
 * trait-scoped offer priced ABOVE the top collection-wide offer, so the
 * "above-market offer" detection path has something to find in mock mode.
 */
export function mockCollectionOffers(collectionId: string, limit = 5): CollectionOfferInfo[] {
  const base = mockCollectionFor(collectionId);
  const topCollectionOffer = Number((base.basePrice * 0.35).toFixed(4));
  const short = collectionId.slice(2, 8);

  const offers: CollectionOfferInfo[] = [
    {
      id: `mock-offer-${short}-collection-0`,
      collectionId,
      priceNative: topCollectionOffer,
      priceCurrency: "ETH",
      bidder: "0xmockcollectionbidder0",
      source: "opensea-mock",
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      scope: "collection",
    },
    {
      id: `mock-offer-${short}-collection-1`,
      collectionId,
      priceNative: Number((topCollectionOffer * 0.82).toFixed(4)),
      priceCurrency: "ETH",
      bidder: "0xmockcollectionbidder1",
      source: "opensea-mock",
      createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      scope: "collection",
    },
    {
      id: `mock-offer-${short}-trait-0`,
      collectionId,
      priceNative: Number((topCollectionOffer * 1.5).toFixed(4)),
      priceCurrency: "ETH",
      bidder: "0xmocktraitbidder0",
      source: "opensea-mock",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      scope: "trait",
      trait: MOCK_TRAITS[0],
    },
    {
      id: `mock-offer-${short}-trait-1`,
      collectionId,
      priceNative: Number((topCollectionOffer * 0.6).toFixed(4)),
      priceCurrency: "ETH",
      bidder: "0xmocktraitbidder1",
      source: "opensea-mock",
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      scope: "trait",
      trait: MOCK_TRAITS[2],
    },
  ];

  return offers.slice(0, limit);
}

/**
 * Best offer for a specific token, if any. Roughly 1 in 3 tokens gets a
 * standout offer priced above the mock collection offer, to exercise the
 * per-token "above collection offer" bid-lead path deterministically enough
 * to be useful in smoke tests without being true for every single token.
 */
export function mockBestOfferForToken(collectionId: string, tokenId: string): CollectionOfferInfo | null {
  const base = mockCollectionFor(collectionId);
  const topCollectionOffer = base.basePrice * 0.35;
  const numericTokenId = Number(tokenId);
  const seed = Number.isFinite(numericTokenId) ? numericTokenId : tokenId.length;
  if (seed % 3 !== 0) return null;

  const price = topCollectionOffer * (1.2 + (seed % 5) * 0.05);
  return {
    id: `mock-offer-${collectionId.slice(2, 8)}-token-${tokenId}`,
    collectionId,
    priceNative: Number(price.toFixed(4)),
    priceCurrency: "ETH",
    bidder: `0xmocktokenbidder${tokenId}`,
    source: "opensea-mock",
    createdAt: new Date().toISOString(),
    scope: "token",
  };
}

export function mockRecentSales(collectionId: string, limit = 5): SaleInfo[] {
  const base = mockCollectionFor(collectionId);
  const short = collectionId.slice(2, 8);
  return Array.from({ length: limit }, (_, i) => {
    const price = base.basePrice * (0.5 + Math.random() * 0.5);
    const tokenId = String(1000 + i);
    const transactionHash = `0xmocktx-${short}-${i}`;
    return {
      // Same rationale as mockRecentListings/mockRecentBids — stable ID, no Date.now().
      id: `${transactionHash}:${tokenId}`,
      collectionId,
      tokenId,
      priceNative: Number(price.toFixed(4)),
      priceCurrency: "ETH",
      buyer: `0xmockbuyer${i.toString().padStart(3, "0")}`,
      seller: `0xmockseller${i.toString().padStart(3, "0")}`,
      source: "opensea-mock",
      createdAt: new Date(Date.now() - i * 120_000).toISOString(),
      imageUrl: mockNftImage(collectionId, tokenId),
      transactionHash,
    };
  });
}

/** Fixed, clearly-a-placeholder ETH/USD rate for mock mode — deterministic so mock-mode tests/screenshots don't shift with the real market. */
export function mockEthUsdRate(): number {
  return 3000;
}
