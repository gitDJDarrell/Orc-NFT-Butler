import type { ResolvedCollection } from "../opensea/client.js";
import type { CollectionInfo } from "../types/index.js";

export interface PendingAdd {
  resolved: ResolvedCollection;
  floor: CollectionInfo | null;
  createdAt: string;
}

/**
 * In-memory index of /watchlist add previews awaiting a Confirm/Cancel
 * button click — keyed by a short random token embedded in the button's
 * custom ID, since (unlike PendingLeadStore) the token has to exist BEFORE
 * the preview message does, to build the buttons' custom IDs ahead of
 * sending. Resets on restart, same posture as every other in-memory
 * runtime/interaction state in this project — a preview left unconfirmed
 * across a restart just can't be confirmed anymore; the user re-runs
 * /watchlist add.
 */
export class PendingAddStore {
  private readonly pending = new Map<string, PendingAdd>();

  add(token: string, resolved: ResolvedCollection, floor: CollectionInfo | null): void {
    this.pending.set(token, { resolved, floor, createdAt: new Date().toISOString() });
  }

  get(token: string): PendingAdd | undefined {
    return this.pending.get(token);
  }

  remove(token: string): void {
    this.pending.delete(token);
  }
}
