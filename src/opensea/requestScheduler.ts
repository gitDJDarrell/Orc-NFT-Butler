/**
 * Central rate-limit-aware scheduler for every OpenSea API call.
 * OpenSeaClient.request() routes ALL calls (floor, listings, sales, offers,
 * traits, slug resolution, search, NFT details, ...) through this single
 * choke point, so it's the one place that:
 *
 *   - Paces requests against a token-bucket budget (a sliding 60s window,
 *     capped at `requestsPerMinute` dispatches) — anything over budget
 *     queues instead of firing immediately and tripping a 429.
 *   - Coalesces duplicate concurrent requests: two callers asking for the
 *     exact same URL at once (e.g. two collections' poll ticks landing in
 *     the same instant, or a poll tick overlapping a slash command) share
 *     one dispatch and one response instead of each burning budget.
 *   - Backs off after a 429: honors the response's `Retry-After` header if
 *     present, otherwise a short fixed pause, before dispatching anything
 *     else — this is what "respect backoff" means here, since OpenSea's v2
 *     API is consumed directly over fetch rather than through an official
 *     rate-limit-aware SDK.
 *   - Tracks health (requests in the last minute, recent 429s, queue depth)
 *     via getHealth(), consumed by the /status command.
 */

export interface RateLimitHealth {
  requestsInLastMinute: number;
  budgetPerMinute: number;
  queueLength: number;
  /** 429s seen in the last hour. */
  recent429Count: number;
  last429At?: string;
  /** Set while a Retry-After backoff is actively delaying dispatch. */
  pausedUntil?: string;
}

const HOUR_MS = 60 * 60_000;
const DEFAULT_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RequestScheduler {
  private readonly requestsPerMinute: number;
  /** The sliding budget window, in ms — 60s in production. Test-injectable (2nd constructor arg) so tests don't have to wait 60 real seconds to see queuing/dispatch-after-window behavior. */
  private readonly windowMs: number;
  /** Dispatch timestamps within the trailing window, for both budgeting and health reporting. */
  private dispatchTimestamps: number[] = [];
  private queue: Array<() => void> = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private draining = false;
  private pausedUntil = 0;
  private recent429s: number[] = [];

  constructor(requestsPerMinute: number, windowMs = 60_000) {
    this.requestsPerMinute = Math.max(1, requestsPerMinute);
    this.windowMs = windowMs;
  }

  /** Runs `fn` under the rate-limit budget, coalescing concurrent callers that pass the same `key` (typically the request URL) into a single in-flight dispatch. */
  async schedule<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = this.enqueue(fn);
    this.inFlight.set(key, promise);
    // NOT promise.finally(cleanup) — .finally() returns a new promise that
    // re-rejects with the same reason, and since nothing here awaits or
    // catches THAT derived promise, a failed request (routine — 429s,
    // resolveSlug misses, timeouts) would fire a genuine unhandled
    // rejection on every call, independent of whether the original
    // `promise` returned below is properly handled by our caller. Passing
    // both handlers to .then() cleans up without ever producing a
    // rejected-and-unobserved promise.
    const cleanup = () => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  /** Call after any request comes back 429, so the scheduler pauses further dispatch instead of hammering straight into the next rate-limit window. */
  recordRateLimited(retryAfterSeconds?: number): void {
    const now = Date.now();
    this.recent429s.push(now);
    this.recent429s = this.recent429s.filter((t) => now - t < HOUR_MS);
    const backoffMs = retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) ? Math.max(0, retryAfterSeconds * 1000) : DEFAULT_BACKOFF_MS;
    this.pausedUntil = Math.max(this.pausedUntil, now + backoffMs);
  }

  getHealth(): RateLimitHealth {
    const now = Date.now();
    this.dispatchTimestamps = this.dispatchTimestamps.filter((t) => now - t < this.windowMs);
    this.recent429s = this.recent429s.filter((t) => now - t < HOUR_MS);
    return {
      requestsInLastMinute: this.dispatchTimestamps.length,
      budgetPerMinute: this.requestsPerMinute,
      queueLength: this.queue.length,
      recent429Count: this.recent429s.length,
      last429At: this.recent429s.length > 0 ? new Date(this.recent429s[this.recent429s.length - 1]!).toISOString() : undefined,
      pausedUntil: this.pausedUntil > now ? new Date(this.pausedUntil).toISOString() : undefined,
    };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        fn().then(resolve, reject);
      });
      void this.drain();
    });
  }

  /** Dispatches queued tasks as budget allows. Not awaited by callers of enqueue() — a task's own network latency doesn't block the next dispatch, only the per-minute count does, so a burst within budget goes out together rather than serializing on round-trip time. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const now = Date.now();
        if (now < this.pausedUntil) {
          await sleep(this.pausedUntil - now);
          continue;
        }

        this.dispatchTimestamps = this.dispatchTimestamps.filter((t) => Date.now() - t < this.windowMs);
        if (this.dispatchTimestamps.length >= this.requestsPerMinute) {
          const oldest = this.dispatchTimestamps[0]!;
          const waitMs = this.windowMs - (Date.now() - oldest) + 25;
          await sleep(Math.max(waitMs, 25));
          continue;
        }

        const task = this.queue.shift();
        if (!task) break;
        this.dispatchTimestamps.push(Date.now());
        task();
      }
    } finally {
      this.draining = false;
    }
  }
}
