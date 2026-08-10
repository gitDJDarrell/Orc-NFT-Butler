import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** One floor/volume observation for a collection. */
export interface FloorSample {
  /** ISO timestamp of the observation. */
  t: string;
  /** Floor price in the collection's native currency at that moment. */
  floor: number;
  /** Trailing-24h volume, when OpenSea reported one (see CollectionInfo.volume24hNative). */
  volume?: number;
}

interface HistoryState {
  [collectionId: string]: FloorSample[];
}

/**
 * Retention per collection. At the default hourly poll cadence this is ~30
 * days of samples — comfortably more than the 24h/7d windows the chart and
 * the daily recap actually read, with headroom for a shorter
 * POLL_INTERVAL_SECONDS.
 */
const MAX_SAMPLES_PER_COLLECTION = 720;

/**
 * Persists a rolling floor/volume time series per allowlisted collection —
 * the data behind the trend digest's chart image and the once-daily
 * overnight recap. Written on the normal poll tick from the floor reading
 * that tick ALREADY fetched, so it costs no additional OpenSea calls.
 *
 * Same load-on-construct / save-on-write pattern as the other stores here,
 * so history survives restarts.
 */
export class FloorHistoryStore {
  private readonly path: string;
  private state: HistoryState;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): HistoryState {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as HistoryState;
      // Guard against a hand-edited/corrupt file turning into a crash deep
      // in chart rendering rather than here.
      for (const [id, samples] of Object.entries(parsed)) {
        if (!Array.isArray(samples)) delete parsed[id];
      }
      return parsed;
    } catch (err) {
      console.warn(`[history-store] failed to read ${this.path}, starting fresh: ${(err as Error).message}`);
      return {};
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.state), "utf8");
    } catch (err) {
      console.warn(`[history-store] failed to write ${this.path}: ${(err as Error).message}`);
    }
  }

  /** Appends one observation, trimming the oldest past MAX_SAMPLES_PER_COLLECTION. */
  record(collectionId: string, sample: FloorSample): void {
    const key = collectionId.toLowerCase();
    const existing = this.state[key] ?? [];
    existing.push(sample);
    this.state[key] = existing.length > MAX_SAMPLES_PER_COLLECTION ? existing.slice(existing.length - MAX_SAMPLES_PER_COLLECTION) : existing;
    this.save();
  }

  /** Every retained sample for a collection, oldest first. */
  getAll(collectionId: string): FloorSample[] {
    return this.state[collectionId.toLowerCase()] ?? [];
  }

  /** Samples within the trailing `hours` window, oldest first. */
  getSince(collectionId: string, hours: number): FloorSample[] {
    const cutoff = Date.now() - hours * 3_600_000;
    return this.getAll(collectionId).filter((s) => {
      const t = new Date(s.t).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }

  /** Drops a collection's series — called when it leaves the watchlist, matching SeenStore.forget. */
  forget(collectionId: string): void {
    const key = collectionId.toLowerCase();
    if (key in this.state) {
      delete this.state[key];
      this.save();
    }
  }
}
