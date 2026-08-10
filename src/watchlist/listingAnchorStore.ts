import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface ListingAnchor {
  messageId: string;
  threadId?: string;
  /** The single living "still listed" status message inside the thread — edited in place on each recurrence rather than reposted. */
  statusMessageId?: string;
  /** How many times this listing has been observed (1 = only the original post, 2 = one recurrence, ...). */
  seenCount?: number;
  price: number;
  priceCurrency: string;
}

interface AnchorState {
  [collectionId: string]: {
    [tokenId: string]: ListingAnchor;
  };
}

/** Crude-but-safe cap matching the same "clear on overflow" pattern used for the in-memory seen-ID sets elsewhere in leadMonitor.ts — a long-running collection with heavy turnover just loses old anchors rather than growing this file unboundedly. */
const MAX_TOKENS_PER_COLLECTION = 500;

/**
 * Persists, per collection+token, which Discord message currently
 * represents "the" #new-listings post for that token — and the thread (if
 * any) hanging off it — so BidLeadMonitor can tell a still-active listing
 * apart from a genuinely new one, and thread "still listed" recurrence
 * notes onto the right original message across restarts.
 */
export class ListingAnchorStore {
  private readonly path: string;
  private state: AnchorState;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): AnchorState {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as AnchorState;
    } catch (err) {
      console.warn(`[listing-anchors] failed to read ${this.path}, starting fresh: ${(err as Error).message}`);
      return {};
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.state), "utf8");
    } catch (err) {
      console.warn(`[listing-anchors] failed to write ${this.path}: ${(err as Error).message}`);
    }
  }

  get(collectionId: string, tokenId: string): ListingAnchor | undefined {
    return this.state[collectionId]?.[tokenId];
  }

  /** Full upsert — call when a token gets a fresh top-level post (new listing or price change), replacing whatever anchor it had before. */
  set(collectionId: string, tokenId: string, anchor: ListingAnchor): void {
    const forCollection = this.state[collectionId] ?? {};
    forCollection[tokenId] = anchor;

    const tokenIds = Object.keys(forCollection);
    this.state[collectionId] = tokenIds.length > MAX_TOKENS_PER_COLLECTION ? { [tokenId]: anchor } : forCollection;
    this.save();
  }

  /** Patches thread/status-message/seen-count on an existing anchor after a recurrence — so future recurrences reuse the same thread AND edit the same status message in place instead of creating/posting fresh ones each time. */
  updateRecurrence(collectionId: string, tokenId: string, patch: { threadId: string; statusMessageId: string; seenCount: number }): void {
    const anchor = this.state[collectionId]?.[tokenId];
    if (!anchor) return;
    anchor.threadId = patch.threadId;
    anchor.statusMessageId = patch.statusMessageId;
    anchor.seenCount = patch.seenCount;
    this.save();
  }
}
