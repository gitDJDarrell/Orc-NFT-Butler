import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { OfferScope } from "../types/index.js";

/** The highest offer recorded for a collection — the high-water mark #highest-offers compares against. */
export interface HighestOfferRecord {
  /** Order hash of the offer that set this high — lets us tell "still standing" from "expired". */
  offerId: string;
  priceNative: number;
  priceCurrency: string;
  scope: OfferScope;
  /** Present for item-scoped offers. */
  tokenId?: string;
  bidder: string;
  recordedAt: string;
}

interface HighestOfferState {
  [collectionId: string]: HighestOfferRecord;
}

/**
 * Persists the highest offer seen per allowlisted collection, so
 * #highest-offers only fires on a genuine new record and a restart never
 * replays the current high as if it just appeared.
 *
 * Same load-on-construct / save-on-write pattern as SeenStore, WatchStore,
 * WhaleStore and ListingAnchorStore.
 */
export class HighestOfferStore {
  private readonly path: string;
  private state: HighestOfferState;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): HighestOfferState {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as HighestOfferState;
      // A hand-edited/corrupt entry should degrade to "no record" (which
      // re-baselines silently) rather than throw deep inside a poll tick.
      for (const [id, rec] of Object.entries(parsed)) {
        if (!rec || typeof rec.priceNative !== "number" || !Number.isFinite(rec.priceNative)) delete parsed[id];
      }
      return parsed;
    } catch (err) {
      console.warn(`[highest-offer-store] failed to read ${this.path}, starting fresh: ${(err as Error).message}`);
      return {};
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.state), "utf8");
    } catch (err) {
      console.warn(`[highest-offer-store] failed to write ${this.path}: ${(err as Error).message}`);
    }
  }

  get(collectionId: string): HighestOfferRecord | undefined {
    return this.state[collectionId.toLowerCase()];
  }

  set(collectionId: string, record: HighestOfferRecord): void {
    this.state[collectionId.toLowerCase()] = record;
    this.save();
  }

  /** Drops a collection's record — called when it leaves the watchlist, matching SeenStore.forget. */
  forget(collectionId: string): void {
    const key = collectionId.toLowerCase();
    if (key in this.state) {
      delete this.state[key];
      this.save();
    }
  }

  getAll(): Array<{ collectionId: string; record: HighestOfferRecord }> {
    return Object.entries(this.state).map(([collectionId, record]) => ({ collectionId, record }));
  }
}
