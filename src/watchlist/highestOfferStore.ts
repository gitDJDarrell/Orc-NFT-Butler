import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { OfferScope, Trait } from "../types/index.js";

/** The highest offer recorded for one collection + one scope — the high-water mark #highest-offers compares against. */
export interface HighestOfferRecord {
  /** Order hash of the offer that set this high — lets us tell "still standing" from "expired". */
  offerId: string;
  /** Which market this record belongs to: "collection", "item", or `trait:Key=Value`. See highestOffer.ts scopeKeyFor. */
  scopeKey: string;
  priceNative: number;
  priceCurrency: string;
  scope: OfferScope;
  /** Item-scoped offers only, and only when OpenSea's criteria decoded to a single token. */
  tokenId?: string;
  /** Trait-scoped offers only. */
  trait?: Trait;
  bidder: string;
  recordedAt: string;
}

/** collectionId -> scopeKey -> record. */
interface HighestOfferState {
  [collectionId: string]: { [scopeKey: string]: HighestOfferRecord };
}

function isRecord(value: unknown): value is HighestOfferRecord {
  const rec = value as HighestOfferRecord | undefined;
  return Boolean(rec && typeof rec.offerId === "string" && typeof rec.priceNative === "number" && Number.isFinite(rec.priceNative));
}

/**
 * Persists the highest offer seen per collection PER SCOPE, so
 * #highest-offers only fires on a genuine new record for that scope and a
 * restart never replays a current high as if it just appeared.
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
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      const migrated: HighestOfferState = {};

      for (const [collectionId, value] of Object.entries(parsed)) {
        // Pre-per-scope files stored ONE record per collection. There's no
        // reliable way to know which scope market it belonged to, so it's
        // dropped rather than mis-filed — the collection simply re-baselines
        // on the next tick, which posts nothing. Silent and safe.
        if (isRecord(value)) {
          console.warn(`[highest-offer-store] Dropping pre-per-scope record for ${collectionId}; it will re-baseline silently.`);
          continue;
        }

        if (!value || typeof value !== "object") continue;

        const byScope: { [scopeKey: string]: HighestOfferRecord } = {};
        for (const [scopeKey, rec] of Object.entries(value as Record<string, unknown>)) {
          if (isRecord(rec)) byScope[scopeKey] = rec;
        }
        if (Object.keys(byScope).length > 0) migrated[collectionId] = byScope;
      }

      return migrated;
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

  /** Every scope's record for a collection, keyed by scope key. Empty object when nothing is recorded yet. */
  getForCollection(collectionId: string): Readonly<Record<string, HighestOfferRecord>> {
    return this.state[collectionId.toLowerCase()] ?? {};
  }

  get(collectionId: string, scopeKey: string): HighestOfferRecord | undefined {
    return this.state[collectionId.toLowerCase()]?.[scopeKey];
  }

  set(collectionId: string, scopeKey: string, record: HighestOfferRecord): void {
    const key = collectionId.toLowerCase();
    const byScope = this.state[key] ?? {};
    byScope[scopeKey] = record;
    this.state[key] = byScope;
    this.save();
  }

  /** Drops a collection's records — called when it leaves the watchlist, matching SeenStore.forget. */
  forget(collectionId: string): void {
    const key = collectionId.toLowerCase();
    if (key in this.state) {
      delete this.state[key];
      this.save();
    }
  }

  /** Total number of scope records held, across all collections. Used for startup logging. */
  get size(): number {
    return Object.values(this.state).reduce((n, byScope) => n + Object.keys(byScope).length, 0);
  }
}
