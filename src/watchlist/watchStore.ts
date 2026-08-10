import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface WatchedItem {
  collectionId: string;
  collectionName: string;
  tokenId: string;
  lastKnownPriceNative: number;
  lastKnownPriceCurrency: string;
  addedAt: string;
  /**
   * Consecutive poll ticks this token hasn't appeared in either the
   * collection's recent-listings or recent-sales window — used as a
   * best-effort "likely delisted" signal (see leadMonitor.ts
   * checkWatchedSubjects). Not a guarantee: both windows are capped-size
   * recent-activity feeds, not a full live snapshot, so a quiet/low-churn
   * collection could occasionally miss a tick without the token actually
   * being delisted. Resets to 0 any time the token reappears.
   */
  missingTicks: number;
}

interface WatchState {
  [collectionId: string]: {
    [tokenId: string]: WatchedItem;
  };
}

/**
 * Persists the 👀-watch list across restarts — replaces the old in-memory
 * `Map` that reset every time the process restarted. Same
 * load-on-construct/save-on-write pattern as ListingAnchorStore/SeenStore.
 */
export class WatchStore {
  private readonly path: string;
  private state: WatchState;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): WatchState {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as WatchState;
    } catch (err) {
      console.warn(`[watch-store] failed to read ${this.path}, starting fresh: ${(err as Error).message}`);
      return {};
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.state), "utf8");
    } catch (err) {
      console.warn(`[watch-store] failed to write ${this.path}: ${(err as Error).message}`);
    }
  }

  add(item: WatchedItem): void {
    const forCollection = this.state[item.collectionId] ?? {};
    forCollection[item.tokenId] = item;
    this.state[item.collectionId] = forCollection;
    this.save();
  }

  get(collectionId: string, tokenId: string): WatchedItem | undefined {
    return this.state[collectionId]?.[tokenId];
  }

  remove(collectionId: string, tokenId: string): boolean {
    const forCollection = this.state[collectionId];
    if (!forCollection || !(tokenId in forCollection)) return false;
    delete forCollection[tokenId];
    if (Object.keys(forCollection).length === 0) delete this.state[collectionId];
    this.save();
    return true;
  }

  /** Shallow-merges a patch into an existing watched item (e.g. a fresh price, or an incremented/reset missingTicks) — no-op if the item isn't tracked. */
  update(collectionId: string, tokenId: string, patch: Partial<Omit<WatchedItem, "collectionId" | "tokenId">>): void {
    const item = this.state[collectionId]?.[tokenId];
    if (!item) return;
    Object.assign(item, patch);
    this.save();
  }

  getAll(): WatchedItem[] {
    return Object.values(this.state).flatMap((byToken) => Object.values(byToken));
  }

  getForCollection(collectionId: string): WatchedItem[] {
    return Object.values(this.state[collectionId] ?? {});
  }
}
