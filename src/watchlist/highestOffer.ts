import type { CollectionOfferInfo } from "../types/index.js";
import type { HighestOfferRecord } from "./highestOfferStore.js";

/**
 * Pure decision logic for the #highest-offers feed — no I/O, no Discord, no
 * network, so the "is this actually a new record?" rules are directly
 * unit-testable.
 *
 * Records are tracked PER SCOPE rather than as one blended maximum, because
 * the three kinds of offer are not comparable:
 *
 *   - collection : anyone will pay X for ANY item in the collection.
 *   - trait      : anyone will pay X for any item WITH A GIVEN TRAIT —
 *                  tracked separately per trait, since "Background = Blue"
 *                  and "Fur = Gold" are independent markets.
 *   - item       : anyone will pay X for ONE SPECIFIC token.
 *
 * A whole-collection offer of 1 ETH and a trait-exclusive offer of 1 ETH say
 * very different things, and a single blended max would let a big item offer
 * permanently mask every collection-wide record (and vice versa). Each scope
 * therefore keeps its own high-water mark and fires its own notification.
 */

/** Stable key identifying which "market" a record belongs to. */
export type ScopeKey = string;

export const SCOPE_KEY_COLLECTION = "collection";
export const SCOPE_KEY_ITEM = "item";

/**
 * All item offers share ONE record (the highest offer on any single token in
 * the collection), while traits are keyed individually — that's the split
 * the user cares about: "someone raised their bid on a specific token" is
 * one signal regardless of which token, whereas each trait is its own market.
 */
export function scopeKeyFor(offer: CollectionOfferInfo): ScopeKey {
  if (offer.scope === "trait") {
    return offer.trait ? `trait:${offer.trait.key}=${offer.trait.value}` : "trait:unspecified";
  }
  if (offer.scope === "token") return SCOPE_KEY_ITEM;
  return SCOPE_KEY_COLLECTION;
}

/** What the monitor should do for ONE scope of one collection. */
export type HighestOfferDecision =
  | { action: "baseline"; scopeKey: ScopeKey; record: HighestOfferRecord; reason: "first-run" | "record-expired" }
  | { action: "post"; scopeKey: ScopeKey; record: HighestOfferRecord; previous: HighestOfferRecord }
  | { action: "none"; scopeKey: ScopeKey; reason: "no-offers" | "not-a-new-high" | "same-offer" };

/**
 * Highest offer within a single already-scoped group. Ties break on the
 * lexicographically smallest order hash so the choice is stable across ticks
 * and can't oscillate between two equal offers (same class of bug as the
 * listing-ladder flip-flop; see lowestListing.ts).
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

/** Buckets a tick's offers by scope key. */
export function groupOffersByScope(offers: readonly CollectionOfferInfo[]): Map<ScopeKey, CollectionOfferInfo[]> {
  const grouped = new Map<ScopeKey, CollectionOfferInfo[]>();
  for (const offer of offers) {
    const key = scopeKeyFor(offer);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(offer);
    else grouped.set(key, [offer]);
  }
  return grouped;
}

function toRecord(offer: CollectionOfferInfo, scopeKey: ScopeKey, now: Date): HighestOfferRecord {
  return {
    offerId: offer.id,
    scopeKey,
    priceNative: offer.priceNative,
    priceCurrency: offer.priceCurrency,
    scope: offer.scope,
    ...(offer.tokenId ? { tokenId: offer.tokenId } : {}),
    ...(offer.trait ? { trait: offer.trait } : {}),
    bidder: offer.bidder,
    recordedAt: now.toISOString(),
  };
}

/**
 * Decides one scope's outcome. Rules, in order:
 *   1. No usable offers in this scope -> nothing.
 *   2. No stored record for this scope -> baseline silently (first run).
 *   3. The offer that set the record is no longer among THIS scope's active
 *      offers -> re-baseline silently. Without this a single outlier would
 *      raise that scope's bar permanently and mute it forever once expired.
 *   4. Same offer still on top -> nothing (a standing offer must not repost).
 *   5. Strictly greater -> post.
 *   6. Otherwise -> nothing.
 */
export function decideForScope(
  scopeKey: ScopeKey,
  offers: readonly CollectionOfferInfo[],
  stored: HighestOfferRecord | undefined,
  now: Date = new Date(),
): HighestOfferDecision {
  const best = selectHighestOffer(offers);
  if (!best) return { action: "none", scopeKey, reason: "no-offers" };

  const record = toRecord(best, scopeKey, now);

  if (!stored) return { action: "baseline", scopeKey, record, reason: "first-run" };
  if (best.id === stored.offerId) return { action: "none", scopeKey, reason: "same-offer" };

  if (!offers.some((o) => o.id === stored.offerId)) {
    return { action: "baseline", scopeKey, record, reason: "record-expired" };
  }

  if (best.priceNative > stored.priceNative) {
    return { action: "post", scopeKey, record, previous: stored };
  }

  return { action: "none", scopeKey, reason: "not-a-new-high" };
}

/**
 * Runs decideForScope across every scope present in this tick's offers.
 * Scopes with a stored record but no current offers are left untouched —
 * there's nothing to re-baseline to, and the record expires naturally the
 * next time that scope has offers.
 */
export function decideHighestOffers(
  offers: readonly CollectionOfferInfo[],
  storedByScope: Readonly<Record<ScopeKey, HighestOfferRecord>>,
  now: Date = new Date(),
): HighestOfferDecision[] {
  const decisions: HighestOfferDecision[] = [];
  for (const [scopeKey, group] of groupOffersByScope(offers)) {
    decisions.push(decideForScope(scopeKey, group, storedByScope[scopeKey], now));
  }
  return decisions;
}

/** Human label for a scope, used in logs and the embed. */
export function describeScope(record: HighestOfferRecord, collectionName: string): string {
  if (record.scope === "token") {
    return record.tokenId ? `Item offer — ${collectionName} #${record.tokenId}` : `Item offer — ${collectionName} (specific token)`;
  }
  if (record.scope === "trait") {
    return record.trait ? `Trait offer — ${collectionName} · ${record.trait.key} = ${record.trait.value}` : `Trait offer — ${collectionName}`;
  }
  return `Collection offer — ${collectionName} (any item)`;
}

/** "▲ up from 0.18 ETH (+16.7%)" — the delta line shown on the embed. */
export function describeDelta(current: number, previous: number): string {
  if (previous <= 0) return "first recorded high";
  const pct = ((current - previous) / previous) * 100;
  return `▲ up from ${previous} ETH (+${pct.toFixed(1)}%)`;
}
