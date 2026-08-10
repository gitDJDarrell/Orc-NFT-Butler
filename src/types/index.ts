/** Shared domain types for the agent. */

export interface Trait {
  key: string;
  value: string;
}

/** One trait category and the known values within it, from OpenSea's collection traits endpoint (GET /traits/{slug}) — powers trait autocomplete. */
export interface TraitCategory {
  key: string;
  values: string[];
}

/** A collection match from OpenSea's free-text search or trending list — enough to display + later resolve via its slug. */
export interface CollectionSearchResult {
  slug: string;
  name: string;
  imageUrl?: string;
}

export interface CollectionInfo {
  id: string; // contract address (or slug for mock data)
  name: string;
  floorPriceNative: number;
  floorPriceCurrency: string; // e.g. "ETH"
  chain: string;
  /** Best-effort liquidity signals — populated in mock mode; may be undefined against the live API (see opensea/client.ts). */
  volume24hNative?: number;
  owners?: number;
  listingsCount?: number;
}

export interface ListingInfo {
  id: string;
  collectionId: string;
  tokenId: string;
  priceNative: number;
  priceCurrency: string;
  seller: string;
  source: string; // marketplace, e.g. "opensea"
  createdAt: string; // ISO timestamp
  /** Best-effort rarity/trait signals — populated in mock mode; may be undefined against the live API (see opensea/client.ts). */
  trait?: Trait;
  rank?: number;
  rankPercentile?: number; // 0-100, lower = rarer
  /** This token's full trait list (best-effort, via OpenSeaClient.getNftDetails) — used for trait/trait-floor watchlist matching, which needs to check the token's ENTIRE trait set, not just the single highlighted `trait` above. */
  traits?: Trait[];
}

export interface BidInfo {
  id: string;
  collectionId: string;
  priceNative: number;
  priceCurrency: string;
  bidder: string;
  source: string;
  createdAt: string;
}

/** What an offer applies to: any item in the collection, items with a specific trait, or (best-effort) a narrow/single-token criteria. */
export type OfferScope = "collection" | "trait" | "token";

/** A collection/trait/token-scoped offer, classified from OpenSea's criteria-offer data (see opensea/client.ts getCollectionOffers). */
export interface CollectionOfferInfo extends BidInfo {
  scope: OfferScope;
  trait?: Trait;
}

/** A completed sale, from OpenSea's collection events endpoint (event_type=sale). */
export interface SaleInfo {
  /** `${transactionHash}:${tokenId}` — a tx hash alone isn't a safe dedupe key since one tx can settle more than one sale. */
  id: string;
  collectionId: string;
  tokenId: string;
  priceNative: number;
  priceCurrency: string;
  /** Only populated for stablecoin-denominated sales (the native amount doubles as USD) — OpenSea's events endpoint has no live FX conversion. */
  priceUsd?: number;
  buyer: string;
  seller: string;
  source: string;
  createdAt: string;
  imageUrl?: string;
  transactionHash: string;
}

export type OrderAction = "buy" | "list" | "bid" | "acceptOffer";

export interface OrderRequest {
  action: OrderAction;
  collectionId: string;
  tokenId?: string; // required for buy/list/acceptOffer
  priceNative?: number; // required for list/bid
  priceCurrency?: string; // defaults to "ETH"
  offerId?: string; // required for acceptOffer
  requestedBy?: string; // free-text label of who/what requested it
}

export interface DryRunResult {
  dryRun: true;
  action: OrderAction;
  summary: string;
  params: Record<string, unknown>;
  estimatedGasUnits: number;
  estimatedGasCostNative: number;
  gasCurrency: string;
  wouldSubmitTo: string;
  timestamp: string;
}

export type AlertSeverity = "info" | "warning";

/** Discriminates alert origin so the Discord bot can route to the right channel; optional so existing callers/tests are unaffected. */
export type AlertKind = "floor-move" | "new-listing" | "price-change";

export interface Alert {
  title: string;
  message: string;
  severity: AlertSeverity;
  collectionId?: string;
  data?: Record<string, unknown>;
  kind?: AlertKind;
  /** Token image (new-listing alerts) or collection image/banner (trend-move alerts), for the Discord embed. Best-effort — omitted if unavailable. */
  imageUrl?: string;
  thumbnailUrl?: string;
  /** When this alert was generated (ISO timestamp) — rendered as the embed's native timestamp. */
  timestamp?: string;
}

/** An Alert as recorded for the dashboard feed — same object that reaches Discord/email, plus feed bookkeeping. */
export interface AlertRecord extends Alert {
  id: string;
  timestamp: string;
}

/** A row in the dashboard watchlist table. */
export interface WatchlistEntry {
  id: string;
  name: string;
  floorPriceNative: number | null;
  floorPriceCurrency: string;
  change24hPct: number | null;
  /** True when there isn't yet a full 24h of history and the change is measured from the oldest available sample instead. */
  changeApprox: boolean;
  lastUpdated: string | null;
}
