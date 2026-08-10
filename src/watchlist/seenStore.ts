import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface SeenState {
  [collectionId: string]: {
    listings: string[];
    sales: string[];
  };
}

const MAX_IDS_PER_COLLECTION = 1000;

/**
 * Persists each collection's already-seen listing/sale IDs to a small JSON
 * file across restarts, so restarting the bot never re-detects pre-existing
 * listings/sales as "new" and dumps a backfill burst to #new-listings,
 * #bid-leads, or #watchlist-sales. A collectionId with no entry here yet is
 * "new" — BidLeadMonitor's first poll for it establishes a silent baseline
 * (see pollCollection) instead of posting everything currently on the
 * market, then this store remembers that baseline forever after.
 */
export class SeenStore {
  private readonly path: string;
  private state: SeenState;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): SeenState {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as SeenState;
    } catch (err) {
      console.warn(`[seen-store] failed to read ${this.path}, starting fresh: ${(err as Error).message}`);
      return {};
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.state), "utf8");
    } catch (err) {
      console.warn(`[seen-store] failed to write ${this.path}: ${(err as Error).message}`);
    }
  }

  /** True iff this collection has never had a baseline established — i.e. its very first poll. */
  isNewCollection(collectionId: string): boolean {
    return !(collectionId in this.state);
  }

  getListingIds(collectionId: string): Set<string> {
    return new Set(this.state[collectionId]?.listings ?? []);
  }

  getSaleIds(collectionId: string): Set<string> {
    return new Set(this.state[collectionId]?.sales ?? []);
  }

  /** Merges freshly-observed listing/sale IDs into the persisted baseline for one collection and writes it to disk immediately (hourly cadence — negligible I/O). */
  recordSeen(collectionId: string, observed: { listingIds: Iterable<string>; saleIds: Iterable<string> }): void {
    const existing = this.state[collectionId] ?? { listings: [], sales: [] };
    this.state[collectionId] = {
      listings: capTail([...new Set([...existing.listings, ...observed.listingIds])], MAX_IDS_PER_COLLECTION),
      sales: capTail([...new Set([...existing.sales, ...observed.saleIds])], MAX_IDS_PER_COLLECTION),
    };
    this.save();
  }

  /** Drops a collection's persisted state entirely — e.g. when it's removed from watchlist.json, so the file doesn't accumulate stale entries forever. */
  forget(collectionId: string): void {
    if (collectionId in this.state) {
      delete this.state[collectionId];
      this.save();
    }
  }
}

function capTail(ids: string[], max: number): string[] {
  return ids.length > max ? ids.slice(ids.length - max) : ids;
}
