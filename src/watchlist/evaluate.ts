import type { Trait } from "../types/index.js";
import type { BidLeadCandidate } from "./candidate.js";
import type { LeadLimiter } from "./limiter.js";
import type { AllowlistConfig, AllowlistEntry } from "./schema.js";

/**
 * Whether a candidate carries a given trait — checked against the token's
 * full trait list (`candidate.traits`, populated from live NFT detail data)
 * if available, falling back to the single highlighted `candidate.trait`
 * (the only signal mock data / older code paths populate). A live listing
 * can carry a dozen-plus traits; without the full-list check, trait-based
 * conditions could only ever match whichever one happened to be
 * "highlighted".
 */
function candidateHasTrait(candidate: BidLeadCandidate, trait: Trait): boolean {
  if (candidate.traits && candidate.traits.length > 0) {
    return candidate.traits.some((t) => t.key === trait.key && t.value === trait.value);
  }
  return candidate.trait !== undefined && candidate.trait.key === trait.key && candidate.trait.value === trait.value;
}

export interface WatchlistMatch {
  entry: AllowlistEntry;
  /** Human-readable explanations of why this candidate matched, used as the Discord embed's reasoning. */
  reasoning: string[];
}

interface MatchAttempt {
  matched: boolean;
  reasoning: string[];
}

const NO_MATCH: MatchAttempt = { matched: false, reasoning: [] };

/**
 * Evaluates a bid-lead candidate against the allowlist config. Allowlist-only:
 * a candidate for a collection with no enabled entry never matches, full stop.
 * Among matching entries for the candidate's collection, the first one whose
 * scope (tokenIds/traits/ownerWallets) and filters all pass — and which isn't
 * currently muted/quiet-houred/deduped/rate-limited — wins and is recorded as
 * fired. Returns null if nothing matches or every match is currently suppressed.
 */
export function evaluateCandidate(
  candidate: BidLeadCandidate,
  config: AllowlistConfig,
  limiter: LeadLimiter,
  now: Date = new Date(),
): WatchlistMatch | null {
  const candidateEntries = config.entries.filter(
    (e) => e.enabled && e.collection.toLowerCase() === candidate.collectionId.toLowerCase(),
  );

  for (const entry of candidateEntries) {
    const attempt = matchesEntry(candidate, entry);
    if (!attempt.matched) continue;

    const dedupeKey = `${candidate.collectionId}:${candidate.tokenId}`;
    const suppressReason = limiter.check(entry, dedupeKey, now);
    if (suppressReason) continue;

    limiter.recordFired(entry, dedupeKey, now);
    return { entry, reasoning: attempt.reasoning };
  }

  return null;
}

function matchesEntry(candidate: BidLeadCandidate, entry: AllowlistEntry): MatchAttempt {
  const reasoning: string[] = [];

  if (entry.tokenIds && entry.tokenIds.length > 0 && !entry.tokenIds.includes(candidate.tokenId)) {
    return NO_MATCH;
  }

  if (entry.ownerWallets && entry.ownerWallets.length > 0) {
    const sellerMatches =
      candidate.sellerWallet !== undefined &&
      entry.ownerWallets.some((w) => w.toLowerCase() === candidate.sellerWallet!.toLowerCase());
    if (!sellerMatches) return NO_MATCH;
    reasoning.push(`Seller ${candidate.sellerWallet} is on the tracked wallet list`);
  }

  if (entry.traits && entry.traits.length > 0) {
    const matchedTrait = entry.traits.find((t) => candidateHasTrait(candidate, t));
    if (!matchedTrait) return NO_MATCH;
    reasoning.push(`Matches tracked trait ${matchedTrait.key}: ${matchedTrait.value}`);
  }

  const f = entry.filters;

  if (f.priceBand) {
    if (f.priceBand.maxFloor !== undefined && candidate.floorPriceNative > f.priceBand.maxFloor) return NO_MATCH;
    if (f.priceBand.minFloor !== undefined && candidate.floorPriceNative < f.priceBand.minFloor) return NO_MATCH;
    if (f.priceBand.targetBuyPrice !== undefined) {
      if (candidate.priceNative > f.priceBand.targetBuyPrice) return NO_MATCH;
      reasoning.push(`Priced at ${candidate.priceNative} ${candidate.priceCurrency}, at or under target ${f.priceBand.targetBuyPrice}`);
    }
  }

  if (f.rarity) {
    if (f.rarity.maxRank !== undefined) {
      if (candidate.rank === undefined || candidate.rank > f.rarity.maxRank) return NO_MATCH;
      reasoning.push(`Rank ${candidate.rank} at or under cutoff ${f.rarity.maxRank}`);
    }
    if (f.rarity.maxTopPercentile !== undefined) {
      if (candidate.rankPercentile === undefined || candidate.rankPercentile > f.rarity.maxTopPercentile) return NO_MATCH;
      reasoning.push(`In the top ${f.rarity.maxTopPercentile}% rarity (percentile ${candidate.rankPercentile})`);
    }
  }

  if (f.traitFloor) {
    if (!candidateHasTrait(candidate, f.traitFloor.trait)) return NO_MATCH;
    if (f.traitFloor.maxPrice !== undefined && candidate.priceNative > f.traitFloor.maxPrice) return NO_MATCH;
    if (f.traitFloor.minPrice !== undefined && candidate.priceNative < f.traitFloor.minPrice) return NO_MATCH;
    reasoning.push(`Trait floor match: ${f.traitFloor.trait.key}=${f.traitFloor.trait.value} at ${candidate.priceNative} ${candidate.priceCurrency}`);
  }

  if (f.bidSpread) {
    if (f.bidSpread.minPercentFromFloor !== undefined && candidate.percentFromFloor < f.bidSpread.minPercentFromFloor) return NO_MATCH;
    if (f.bidSpread.maxPercentFromFloor !== undefined && candidate.percentFromFloor > f.bidSpread.maxPercentFromFloor) return NO_MATCH;
    reasoning.push(`${candidate.percentFromFloor > 0 ? "+" : ""}${candidate.percentFromFloor.toFixed(1)}% from floor (floor ${candidate.floorPriceNative} ${candidate.priceCurrency})`);
  }

  if (f.liquidity) {
    if (f.liquidity.minVolume24hNative !== undefined && (candidate.volume24hNative ?? 0) < f.liquidity.minVolume24hNative) return NO_MATCH;
    if (f.liquidity.minOwners !== undefined && (candidate.owners ?? 0) < f.liquidity.minOwners) return NO_MATCH;
    if (f.liquidity.minListingsCount !== undefined && (candidate.listingsCount ?? 0) < f.liquidity.minListingsCount) return NO_MATCH;
    reasoning.push(`Meets liquidity gates (24h vol ${candidate.volume24hNative ?? "?"}, owners ${candidate.owners ?? "?"})`);
  }

  if (f.trend) {
    const floorMoveOk =
      f.trend.minFloorMovePercent === undefined || Math.abs(candidate.floorMovePercent ?? 0) >= f.trend.minFloorMovePercent;
    const spikeOk =
      f.trend.minListingSpikeCount === undefined || (candidate.listingSpikeCount ?? 0) >= f.trend.minListingSpikeCount;
    if (!floorMoveOk || !spikeOk) return NO_MATCH;
    reasoning.push(`Trend trigger: floor move ${candidate.floorMovePercent ?? 0}%, ${candidate.listingSpikeCount ?? 0} new listings this cycle`);
  }

  if (f.walletActivity) {
    if (f.walletActivity.minWhaleValueNative !== undefined && candidate.priceNative < f.walletActivity.minWhaleValueNative) {
      return NO_MATCH;
    }
    reasoning.push(`Wallet-activity threshold met (${candidate.priceNative} ${candidate.priceCurrency})`);
  }

  if (reasoning.length === 0) {
    reasoning.push(`Listed within allowlist entry "${entry.label}"`);
  }

  return { matched: true, reasoning };
}
