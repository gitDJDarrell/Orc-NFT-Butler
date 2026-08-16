import type { CollectionOfferInfo } from "../types/index.js";
import type { HighestOfferRecord } from "./highestOfferStore.js";

/**
 * Pure decision logic for the #highest-offers feed — no I/O, no Discord, no
 * network, so the "is this actually a new record?" rules are directly
 * unit-testable.
 */

/** What the monitor should do with this tick's offers for one collection. */
export type HighestOfferDecision =
  /** First time we've ever seen this collection (or its record expired): remember the current high WITHOUT posting. Same no-backfill posture as listings/sales. */
  | { action: "baseline"; record: HighestOfferRecord; reason: "first-run" | "record-expired" }
  /** A genuine new record high: post it and store it. */
  | { action: "post"; record: HighestOfferRecord; previous: HighestOfferRecord }
  /** Nothing to do — no offers, or the high hasn't been beaten. */
  | { action: "none"; reason: "no-offers" | "not-a-new-high" | "same-offer" };

/**
 * Picks the single highest offer across every scope OpenSea reports —
 * collection-wide, trait, and item — since "the highest offer" for a
 * collection is the best number anyone is currently willing to pay for
 * anything in it, regardless of how the offer is scoped.
 *
 * Ties break on the lexicographically smallest order hash so the choice is
 * stable across ticks and can't oscillate between two equal offers (the same
 * class of bug as the listing-ladder flip-flop; see lowestListing.ts).
 */
export function selectHighestOffer(offers: readonly CollectionOfferInfo[]): CollectionOfferInfo | null {
  let best: CollectionOfferInfo | null = null;
  for (const offer of offers) {
    if (!Number.isFinite(offer.priceNative) || offer.priceNative <= 0) continue;
    if (!best || offer.priceNative > best.priceNative || (offer.priceNative === best.priceNative && offer.id < best.id)) {
      best = offer;
    }
  }
  return best;
}

function toRecord(offer: CollectionOfferInfo, now: Date): HighestOfferRecord {
  const tokenId = extractTokenId(offer);
  return {
    offerId: offer.id,
    priceNative: offer.priceNative,
    priceCurrency: offer.priceCurrency,
    scope: offer.scope,
    ...(tokenId ? { tokenId } : {}),
    bidder: offer.bidder,
    recordedAt: now.toISOString(),
  };
}

/**
 * Decides whether this tick's offers represent a new record high.
 *
 * Rules, in order:
 *   1. No usable offers -> nothing.
 *   2. No stored record -> baseline silently (first run for this collection).
 *   3. The offer that set the stored record is NO LONGER among the active
 *      offers -> that record has expired/been cancelled, so re-baseline to
 *      the current high silently rather than posting. Without this, a single
 *      outlier offer would raise the bar permanently and the channel would
 *      go quiet forever once it expired.
 *   4. Same offer still on top -> nothing (dedupe; a standing offer must not
 *      repost every hour).
 *   5. Strictly greater than the stored high -> post.
 *   6. Otherwise -> nothing.
 */
export function decideHighestOffer(
  offers: readonly CollectionOfferInfo[],
  stored: HighestOfferRecord | undefined,
  now: Date = new Date(),
): HighestOfferDecision {
  const best = selectHighestOffer(offers);
  if (!best) return { action: "none", reason: "no-offers" };

  const record = toRecord(best, now);

  if (!stored) return { action: "baseline", record, reason: "first-run" };

  if (best.id === stored.offerId) return { action: "none", reason: "same-offer" };

  const storedStillActive = offers.some((o) => o.id === stored.offerId);
  if (!storedStillActive) {
    return { action: "baseline", record, reason: "record-expired" };
  }

  if (best.priceNative > stored.priceNative) {
    return { action: "post", record, previous: stored };
  }

  return { action: "none", reason: "not-a-new-high" };
}

/**
 * Best-effort token id for an item-scoped offer. OpenSea's criteria offers
 * carry `encoded_token_ids` rather than a plain id and the client doesn't
 * decode it, so this is only populated when the mapper already surfaced one.
 */
function extractTokenId(offer: CollectionOfferInfo): string | undefined {
  const candidate = (offer as CollectionOfferInfo & { tokenId?: string }).tokenId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** "▲ up from 0.18 ETH (+16.7%)" — the delta line shown on the embed. */
export function describeDelta(current: number, previous: number): string {
  if (previous <= 0) return "first recorded high";
  const pct = ((current - previous) / previous) * 100;
  return `▲ up from ${previous} ETH (+${pct.toFixed(1)}%)`;
}
