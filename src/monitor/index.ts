import { config } from "../config/env.js";
import { openseaClient } from "../opensea/client.js";
import type { Alert, ListingInfo, WatchlistEntry } from "../types/index.js";

interface FloorSample {
  timestamp: number;
  price: number;
}

interface CollectionState {
  name: string | null;
  lastFloorPrice: number | null;
  lastFloorCurrency: string;
  lastUpdated: string | null;
  seenListingIds: Set<string>;
  /** Ascending-by-time floor price samples, pruned to the last ~48h, used for the 24h change figure. */
  history: FloorSample[];
  /** Floor price at the time of the last-fired floor-move alert. Comparing against this (not every tick's raw delta) stops small oscillations around a stable mean from re-triggering an alert every poll. */
  lastAlertedFloorPrice: number | null;
  /** epoch ms of the last-fired floor-move alert, for the cooldown below. */
  lastFloorAlertAt: number | null;
}

export type AlertHandler = (alert: Alert) => void | Promise<void>;

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000;
/** Minimum time between floor-move alerts for the same collection, regardless of how often the price crosses the threshold in that window. */
const MIN_FLOOR_ALERT_INTERVAL_MS = 5 * 60 * 1000;

function freshState(): CollectionState {
  return {
    name: null,
    lastFloorPrice: null,
    lastFloorCurrency: "ETH",
    lastUpdated: null,
    seenListingIds: new Set(),
    history: [],
    lastAlertedFloorPrice: null,
    lastFloorAlertAt: null,
  };
}

/** Percent change from the sample closest to 24h ago to the current price. `approx` is true when history doesn't yet span a full 24h. */
function computeChange24h(history: FloorSample[], currentPrice: number): { pct: number | null; approx: boolean } {
  if (history.length < 2) return { pct: null, approx: false };

  const cutoff = Date.now() - DAY_MS;
  let reference = history[0]!;
  let spansFullDay = false;
  for (const sample of history) {
    if (sample.timestamp <= cutoff) {
      reference = sample;
      spansFullDay = true;
    } else {
      break;
    }
  }

  if (reference.price === 0) return { pct: null, approx: !spansFullDay };
  const pct = ((currentPrice - reference.price) / reference.price) * 100;
  return { pct: Number(pct.toFixed(2)), approx: !spansFullDay };
}

/**
 * Polls watched collections on an interval and emits alerts (via the
 * provided handler) when:
 *   - floor price moves beyond FLOOR_MOVE_THRESHOLD (fractional change), or
 *   - a new listing appears priced at or below NEW_LISTING_MAX_PRICE.
 *
 * Also keeps a lightweight floor-price history per collection so callers
 * (e.g. the dashboard) can read a 24h change figure, and supports adding/
 * removing watched collections at runtime.
 *
 * Keeps small in-memory state per collection between ticks; state resets
 * if the process restarts (no persistence in this version).
 */
export class CollectionMonitor {
  private collections: string[];
  private readonly state = new Map<string, CollectionState>();
  private readonly onAlert: AlertHandler;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(onAlert: AlertHandler, collections?: string[]) {
    this.onAlert = onAlert;
    this.collections = CollectionMonitor.resolveCollections(collections);

    for (const id of this.collections) {
      this.state.set(id, freshState());
    }
  }

  /**
   * Explicit list -> validated WATCHED_COLLECTIONS -> mock defaults.
   *
   * That last fallback is deliberately gated on actually running in mock
   * mode. The default IDs come from the mock fixture table
   * (`mockDefaultCollections`), and those identifiers are not real,
   * resolvable contract addresses — polling them against the LIVE API just
   * produces a `400 Unrecognized address` on every tick, forever. With a
   * live key and nothing valid configured, watching nothing is the honest
   * outcome: the dashboard shows an empty watchlist instead of a permanent
   * error loop. (Malformed WATCHED_COLLECTIONS entries are dropped during
   * config load — see src/config/env.ts.)
   */
  private static resolveCollections(explicit?: string[]): string[] {
    if (explicit && explicit.length > 0) return [...explicit];
    if (config.WATCHED_COLLECTIONS.length > 0) return [...config.WATCHED_COLLECTIONS];

    if (openseaClient.usingMockData) return openseaClient.defaultWatchedCollections();

    console.warn(
      "[monitor] No valid WATCHED_COLLECTIONS configured and a live OpenSea key is present — the dashboard watchlist will be empty. " +
        "Not falling back to the mock demo collections, whose IDs are fixtures rather than real addresses and would fail every poll. " +
        "Note this does not affect the Discord bot, whose allowlist comes from watchlist.json.",
    );
    return [];
  }

  /** The collection IDs this monitor is watching. */
  getWatchedCollections(): string[] {
    return [...this.collections];
  }

  /**
   * Adds a collection to the watchlist. Returns false if it's already
   * watched. Kicks off an immediate background poll so the dashboard
   * doesn't have to wait a full interval to see initial data.
   */
  addCollection(collectionId: string): boolean {
    const id = collectionId.trim();
    if (!id || this.collections.includes(id)) return false;

    this.collections.push(id);
    this.state.set(id, freshState());
    void this.pollCollection(id);
    return true;
  }

  /** Removes a collection from the watchlist. Returns false if it wasn't watched. */
  removeCollection(collectionId: string): boolean {
    const idx = this.collections.indexOf(collectionId);
    if (idx === -1) return false;

    this.collections.splice(idx, 1);
    this.state.delete(collectionId);
    return true;
  }

  /** Snapshot of the current watchlist, from cached poll data (no network calls). */
  getWatchlistSnapshot(): WatchlistEntry[] {
    return this.collections.map((id) => {
      const s = this.state.get(id);
      if (!s || s.lastFloorPrice === null) {
        return {
          id,
          name: s?.name ?? id,
          floorPriceNative: null,
          floorPriceCurrency: "ETH",
          change24hPct: null,
          changeApprox: false,
          lastUpdated: null,
        };
      }

      const { pct, approx } = computeChange24h(s.history, s.lastFloorPrice);
      return {
        id,
        name: s.name ?? id,
        floorPriceNative: s.lastFloorPrice,
        floorPriceCurrency: s.lastFloorCurrency,
        change24hPct: pct,
        changeApprox: approx,
        lastUpdated: s.lastUpdated,
      };
    });
  }

  /** Runs one poll cycle across all watched collections immediately (no wait for interval). */
  async pollOnce(): Promise<void> {
    await Promise.all(this.collections.map((id) => this.pollCollection(id)));
  }

  /** Starts polling on POLL_INTERVAL_SECONDS. Fires an initial poll immediately. */
  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, config.POLL_INTERVAL_SECONDS * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollCollection(collectionId: string): Promise<void> {
    // The collection may have been removed between being scheduled and running.
    const state = this.state.get(collectionId);
    if (!state) return;

    try {
      const [floor, listings] = await Promise.all([
        openseaClient.getFloorPrice(collectionId),
        openseaClient.getRecentListings(collectionId, 10),
      ]);

      state.name = floor.name;
      state.lastFloorCurrency = floor.floorPriceCurrency;
      state.lastUpdated = new Date().toISOString();

      await this.checkFloorMove(collectionId, floor.name, floor.floorPriceNative, floor.floorPriceCurrency, state);
      this.recordHistorySample(state, floor.floorPriceNative);
      await this.checkNewListings(collectionId, floor.name, listings, state);
    } catch (err) {
      console.error(`[monitor] failed to poll collection ${collectionId}: ${(err as Error).message}`);
    }
  }

  private recordHistorySample(state: CollectionState, price: number): void {
    const now = Date.now();
    state.history.push({ timestamp: now, price });

    const cutoff = now - HISTORY_RETENTION_MS;
    while (state.history.length > 0 && state.history[0]!.timestamp < cutoff) {
      state.history.shift();
    }
  }

  private async checkFloorMove(
    collectionId: string,
    name: string,
    newFloor: number,
    currency: string,
    state: CollectionState,
  ): Promise<void> {
    const prev = state.lastFloorPrice;
    state.lastFloorPrice = newFloor;
    if (prev === null || prev === 0) return;

    // Compare against the floor at the time of the LAST FIRED alert (falling
    // back to the previous poll's price before any alert has fired yet),
    // not the immediately-previous tick. Without this, a price that
    // oscillates narrowly around a stable mean (e.g. mock data's sine-wave
    // wobble) re-crosses the threshold on nearly every tick and fires
    // repeatedly forever instead of once per genuine sustained move.
    const baseline = state.lastAlertedFloorPrice ?? prev;
    if (baseline === 0) return;

    const change = (newFloor - baseline) / baseline;
    if (Math.abs(change) < config.FLOOR_MOVE_THRESHOLD) return;

    const now = Date.now();
    if (state.lastFloorAlertAt !== null && now - state.lastFloorAlertAt < MIN_FLOOR_ALERT_INTERVAL_MS) {
      return; // rate limit: at most one floor-move alert per collection per cooldown window
    }

    state.lastAlertedFloorPrice = newFloor;
    state.lastFloorAlertAt = now;

    const direction = change > 0 ? "up" : "down";
    await this.onAlert({
      title: `Floor price moved ${direction} — ${name}`,
      message: `${name} floor moved ${(change * 100).toFixed(1)}% from ${baseline} to ${newFloor} ${currency}.`,
      severity: "warning",
      collectionId,
      data: { previousFloor: baseline, newFloor, percentChange: Number((change * 100).toFixed(2)) },
      kind: "floor-move",
    });
  }

  private async checkNewListings(
    collectionId: string,
    name: string,
    listings: ListingInfo[],
    state: CollectionState,
  ): Promise<void> {
    for (const listing of listings) {
      if (state.seenListingIds.has(listing.id)) continue;
      state.seenListingIds.add(listing.id);

      // Skip alerting on the very first poll's full backlog beyond a cap,
      // to avoid a notification storm on startup; still record as seen.
      if (state.seenListingIds.size > 500) {
        // simple bound so this Set can't grow unbounded over a long-running process
        state.seenListingIds.clear();
      }

      if (listing.priceNative <= config.NEW_LISTING_MAX_PRICE) {
        await this.onAlert({
          title: `New low-priced listing — ${name}`,
          message: `Token ${listing.tokenId} listed for ${listing.priceNative} ${listing.priceCurrency} on ${listing.source}.`,
          severity: "info",
          collectionId,
          data: {
            tokenId: listing.tokenId,
            price: listing.priceNative,
            currency: listing.priceCurrency,
            source: listing.source,
            listingId: listing.id,
          },
          kind: "new-listing",
        });
      }
    }
  }
}
