import type { Trait } from "../types/index.js";

/**
 * A candidate bid-lead built from a fresh marketplace listing plus its
 * collection's current stats. Passed through evaluateCandidate() against
 * the allowlist config before it's ever surfaced to Discord.
 */
export interface BidLeadCandidate {
  collectionId: string;
  collectionName: string;
  tokenId: string;
  trait?: Trait;
  /** This token's full trait list (best-effort, live data only) — used for trait/trait-floor matching against the full set, not just `trait` above. */
  traits?: Trait[];
  priceNative: number;
  priceCurrency: string;
  floorPriceNative: number;
  /** ((priceNative - floorPriceNative) / floorPriceNative) * 100. Negative = priced below floor. */
  percentFromFloor: number;
  rank?: number;
  rankPercentile?: number;
  volume24hNative?: number;
  owners?: number;
  listingsCount?: number;
  /** This collection's floor move (%) since the previous poll tick, if one is available yet. */
  floorMovePercent?: number;
  /** Count of new listings observed for this collection in the same poll tick as this candidate. */
  listingSpikeCount?: number;
  sellerWallet?: string;
  /** This token's most recent completed sale, if it's ever sold before (best-effort, live data only). */
  lastSalePriceNative?: number;
  lastSalePriceCurrency?: string;
  source: string;
  listingId: string;
  timestamp: string;
  /** NFT image for the Discord embed. Best-effort — omitted if unavailable. */
  imageUrl?: string;
  /** Live ETH/USD rate for the embed's "(~$X)" price suffix — undefined shows ETH only, never a fabricated figure. */
  ethUsdRate?: number;
}
