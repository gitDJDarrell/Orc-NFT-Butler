import type { ListingInfo } from "../types/index.js";

/**
 * Collapses a collection's active listings to **one listing per token: the
 * cheapest currently-active one**.
 *
 * Why this exists: OpenSea's `/listings/collection/{slug}/all` returns every
 * active order, and one token frequently carries SEVERAL concurrent orders
 * at near-identical prices (confirmed live — Super Punk World #327 was
 * simultaneously listed at 0.189645 and 0.189656 ETH). The anchor store
 * keys on collection+token, so feeding it each order in turn made the
 * stored price alternate between them, and every alternation was reported
 * as a "▼/▲ Price change" — an endless flip-flop describing no real market
 * movement.
 *
 * Collapsing to the minimum makes that structurally impossible: there is
 * exactly one price per token per tick, so the anchor converges to a single
 * stable value. It's also the semantically right number — the cheapest
 * active ask IS the price you'd pay for that token.
 *
 * Tie-breaking is by listing `id` so the choice is deterministic across
 * ticks; two orders at genuinely identical prices would otherwise be able to
 * swap places between polls and reintroduce churn.
 *
 * Known limitation: prices are compared as raw native amounts without
 * currency normalization. In practice every listing this project sees is
 * ETH/WETH (1:1), and the rest of the codebase makes the same assumption.
 * A token listed in both ETH and a stablecoin would compare a small ETH
 * number against a large USDC one and pick the ETH order — which is very
 * likely the right answer anyway, but it is not a currency-aware
 * comparison.
 */
export function selectLowestListingPerToken(listings: ListingInfo[]): ListingInfo[] {
  const lowestByToken = new Map<string, ListingInfo>();

  for (const listing of listings) {
    const current = lowestByToken.get(listing.tokenId);
    if (!current) {
      lowestByToken.set(listing.tokenId, listing);
      continue;
    }

    if (listing.priceNative < current.priceNative) {
      lowestByToken.set(listing.tokenId, listing);
    } else if (listing.priceNative === current.priceNative && listing.id < current.id) {
      // Deterministic tie-break — see the note above about churn.
      lowestByToken.set(listing.tokenId, listing);
    }
  }

  return [...lowestByToken.values()];
}
