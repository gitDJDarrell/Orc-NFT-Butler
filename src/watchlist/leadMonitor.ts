import { resolve } from "node:path";
import { config } from "../config/env.js";
import {
  applySettingsOverrides,
  getDailyRecapTime,
  getFloorMoveThreshold,
  getNewListingMaxPrice,
  getOfferAboveCollectionThresholdPercent,
  getTrendAlertTimes,
} from "../config/runtime.js";
import { formatPriceWithUsd, openseaClient } from "../opensea/client.js";
import type { Alert, CollectionInfo, CollectionOfferInfo, ListingInfo, SaleInfo, Trait } from "../types/index.js";
import type { BidLeadCandidate } from "./candidate.js";
import { evaluateCandidate, type WatchlistMatch } from "./evaluate.js";
import { renderFloorChart } from "../chart/floorChart.js";
import { decideHighestOffers } from "./highestOffer.js";
import { HighestOfferStore, type HighestOfferRecord } from "./highestOfferStore.js";
import { FloorHistoryStore, type FloorSample } from "./historyStore.js";
import { ListingAnchorStore } from "./listingAnchorStore.js";
import { LeadLimiter } from "./limiter.js";
import { selectLowestListingPerToken } from "./lowestListing.js";
import { buildRecapSummary, emptyCounters, type RecapCounters, type RecapSummary } from "./recap.js";
import { SeenStore } from "./seenStore.js";
import { getAllowlistedCollectionIds, loadWatchlistConfig } from "./store.js";
import type { AllowlistConfig, AllowlistEntry } from "./schema.js";
import { WatchStore, type WatchedItem } from "./watchStore.js";
import { WhaleStore, type WhaleActivity, type WhaleWallet } from "./whaleStore.js";

const SEEN_STORE_PATH = resolve(process.cwd(), ".watchlist-seen-state.json");
const LISTING_ANCHOR_STORE_PATH = resolve(process.cwd(), ".watchlist-listing-anchors.json");
const WATCH_STORE_PATH = resolve(process.cwd(), ".watchlist-watched-items.json");
const WHALE_STORE_PATH = resolve(process.cwd(), ".watchlist-whales.json");
const HISTORY_STORE_PATH = resolve(process.cwd(), ".watchlist-floor-history.json");
const HIGHEST_OFFER_STORE_PATH = resolve(process.cwd(), ".watchlist-highest-offers.json");

/** Consecutive poll ticks a watched token can go missing from both recent-listings and recent-sales before it's treated as likely delisted. See WatchedItem.missingTicks for the caveat. */
const DELIST_THRESHOLD_TICKS = 3;

/** Window the once-daily recap summarizes. 24h so consecutive recaps tile the calendar with no gap or overlap. */
const RECAP_WINDOW_HOURS = 24;

/** Discord allows up to 10 attachments per message; cap below that so a large watchlist can't turn the recap into an image dump. */
const MAX_RECAP_CHARTS = 5;

/** Hours of history the trend digest's per-collection chart plots. */
const TREND_CHART_WINDOW_HOURS = 24;

export type BidLeadHandler = (match: WatchlistMatch, candidate: BidLeadCandidate) => void | Promise<void>;
export type WatchedChangeHandler = (candidate: BidLeadCandidate, previousPriceNative: number) => void | Promise<void>;
export type WatchedSoldHandler = (item: WatchedItem, sale: SaleInfo) => void | Promise<void>;
export type WatchedDelistedHandler = (item: WatchedItem) => void | Promise<void>;
export type AlertHandler = (alert: Alert) => void | Promise<void>;
export type SaleHandler = (sale: SaleInfo, collectionName: string, ethUsdRate: number | undefined) => void | Promise<void>;
/** A marked wallet bought/sold/listed inside an allowlisted collection (Group 3.2). */
export type WhaleActivityHandler = (activity: WhaleActivity) => void | Promise<void>;

/** A collection's top offer set a new record high — see checkHighestOffer. */
export interface HighestOfferEvent {
  collectionId: string;
  collectionName: string;
  /** Used for trait- and collection-scoped offers, which apply to many items. */
  collectionImageUrl?: string;
  /** Item-scoped offers only — the specific token's art. */
  itemImageUrl?: string;
  record: HighestOfferRecord;
  /** The high this beat, within the SAME scope. */
  previous: HighestOfferRecord;
  ethUsdRate?: number;
}
export type HighestOfferHandler = (event: HighestOfferEvent) => void | Promise<void>;
/** The once-daily overnight recap, with an optional locally-rendered chart PNG per collection. */
export type RecapHandler = (summary: RecapSummary, charts: Array<{ label: string; png: Buffer }>) => void | Promise<void>;
/** The twice-daily trend digest, optionally carrying a locally-rendered chart PNG. */
export type TrendAlertWithChartHandler = (alert: Alert, chart: { label: string; png: Buffer } | undefined) => void | Promise<void>;
/** New-listing / price-change alerts need the posted message's ID back (to anchor future threading), unlike the fire-and-forget AlertHandler used for the trend digest. */
export type NewListingHandler = (alert: Alert) => Promise<string | undefined>;
/**
 * Ensures a thread hangs off a #new-listings anchor message, and that it
 * holds exactly one living "still listed" status message (with the NFT
 * image) that gets EDITED in place on each recurrence rather than
 * reposted. Returns the thread's ID and the status message's ID — both
 * freshly created or reused as appropriate — so they can be persisted for
 * next time; undefined on failure.
 */
export type ListingRecurrenceHandler = (params: {
  tokenId: string;
  collectionName: string;
  anchorMessageId: string;
  existingThreadId: string | undefined;
  existingStatusMessageId: string | undefined;
  priceNative: number;
  priceCurrency: string;
  imageUrl: string | undefined;
  seenCount: number;
  lastSeenAt: string;
  ethUsdRate: number | undefined;
}) => Promise<{ threadId: string; statusMessageId: string } | undefined>;

interface CollectionRuntimeState {
  seenListingIds: Set<string>;
  seenSaleIds: Set<string>;
  lastFloorPrice: number | null;
  lastFloorName: string | null;
}

interface TrendTime {
  hour: number;
  minute: number;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parses "08:00,20:00" into [{hour:8,minute:0},{hour:20,minute:0}]. Throws on malformed entries so a typo in .env fails loudly at startup rather than silently never firing. */
export function parseTrendAlertTimes(raw: string): TrendTime[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const m = HH_MM.exec(s);
      if (!m) throw new Error(`Invalid TREND_ALERT_TIMES entry "${s}" — expected 24h HH:MM, e.g. "08:00,20:00"`);
      return { hour: Number(m[1]), minute: Number(m[2]) };
    });
}

/** Milliseconds until the next occurrence of a local time-of-day (today if still ahead, otherwise tomorrow). */
export function msUntilNext(time: TrendTime, from: Date = new Date()): number {
  const next = new Date(from);
  next.setHours(time.hour, time.minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - from.getTime();
}

/**
 * The single allowlist-native source for every collection signal the
 * Discord bot posts — bid leads, new-listing notices, and the twice-daily
 * trend/floor-move digest. `this.collections` comes ONLY from the enabled
 * entries in watchlist.json (see store.ts); nothing else is ever polled or
 * evaluated here, so nothing outside the allowlist can structurally reach
 * any of the three handlers below.
 *
 * This deliberately does NOT share a code path with CollectionMonitor
 * (src/monitor/index.ts), which drives the separate, non-allowlisted
 * WATCHED_COLLECTIONS-based dashboard view — that one's output is never
 * wired to Discord (see src/discord-bot/client.ts).
 *
 * Two independent cadences:
 *   - Bid leads + new listings + sales: every POLL_INTERVAL_SECONDS
 *     (default 3600s / hourly).
 *   - Trend/floor-move digest: only at the local times in TREND_ALERT_TIMES
 *     (default 08:00 and 20:00) — not on the hourly poll loop at all, so it
 *     can't flood regardless of how often prices wobble in between.
 *
 * Restart safety: a collection's first-ever poll (tracked by `seenStore`,
 * persisted to disk — see seenStore.ts) never treats currently-existing
 * listings/sales as "new". Without this, every restart would re-fetch
 * whatever's currently on the market and post it as if it just
 * appeared — a backfill burst, not a real signal. See pollCollection().
 */
/**
 * Handlers + injectable stores. An options object rather than the positional
 * parameter list this used to have: Group 3 added enough optional handlers
 * (whale activity, recap, chart-carrying trend digest) that positional
 * construction had become a long run of `undefined` placeholders at every
 * call site, where a single mis-ordered argument would silently wire the
 * wrong callback.
 */
export interface BidLeadMonitorOptions {
  onLead: BidLeadHandler;
  onWatchedChange?: WatchedChangeHandler;
  onNewListing?: NewListingHandler;
  /** Fired when no chart is available/enabled; onTrendAlertWithChart takes precedence when set. */
  onTrendAlert?: AlertHandler;
  onTrendAlertWithChart?: TrendAlertWithChartHandler;
  onSale?: SaleHandler;
  onListingRecurrence?: ListingRecurrenceHandler;
  onWatchedSold?: WatchedSoldHandler;
  onWatchedDelisted?: WatchedDelistedHandler;
  onWhaleActivity?: WhaleActivityHandler;
  onRecap?: RecapHandler;
  onHighestOffer?: HighestOfferHandler;
  seenStore?: SeenStore;
  listingAnchorStore?: ListingAnchorStore;
  watchStore?: WatchStore;
  whaleStore?: WhaleStore;
  historyStore?: FloorHistoryStore;
  highestOfferStore?: HighestOfferStore;
}

export class BidLeadMonitor {
  private watchlistConfig: AllowlistConfig;
  private collections: string[];
  private readonly state = new Map<string, CollectionRuntimeState>();
  private readonly limiter = new LeadLimiter();
  private readonly seenStore: SeenStore;
  private readonly watchStore: WatchStore;
  private readonly whaleStore: WhaleStore;
  private readonly historyStore: FloorHistoryStore;
  /** Floor price recorded at the last twice-daily trend check, per collection — the baseline the next check compares against. */
  private readonly lastTrendFloor = new Map<string, number>();
  private readonly onLead: BidLeadHandler;
  private readonly onWatchedChange: WatchedChangeHandler | undefined;
  private readonly onNewListing: NewListingHandler | undefined;
  private readonly onTrendAlert: AlertHandler | undefined;
  private readonly onTrendAlertWithChart: TrendAlertWithChartHandler | undefined;
  private readonly onSale: SaleHandler | undefined;
  private readonly onListingRecurrence: ListingRecurrenceHandler | undefined;
  private readonly onWatchedSold: WatchedSoldHandler | undefined;
  private readonly onWatchedDelisted: WatchedDelistedHandler | undefined;
  private readonly onWhaleActivity: WhaleActivityHandler | undefined;
  private readonly onRecap: RecapHandler | undefined;
  private readonly onHighestOffer: HighestOfferHandler | undefined;
  private readonly highestOfferStore: HighestOfferStore;
  private readonly listingAnchorStore: ListingAnchorStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trendTimers: ReturnType<typeof setTimeout>[] = [];
  private recapTimer: ReturnType<typeof setTimeout> | null = null;

  /** For /status: process start time, last poll/trend-check completion, and per-collection activity counts — all in-memory, resets on restart same as everything else here. */
  private readonly startedAt = Date.now();
  private lastPollCompletedAt: string | null = null;
  private lastTrendCheckAt: string | null = null;
  private lastRecapAt: string | null = null;
  private readonly activityCounts = new Map<string, { listings: number; sales: number; leads: number }>();
  /** Per-collection counters for the CURRENT recap window — reset every time a recap posts, unlike activityCounts which is cumulative since startup. */
  private readonly recapCounters = new Map<string, RecapCounters>();

  private bumpActivity(collectionId: string, kind: "listings" | "sales" | "leads"): void {
    const counts = this.activityCounts.get(collectionId) ?? { listings: 0, sales: 0, leads: 0 };
    counts[kind] += 1;
    this.activityCounts.set(collectionId, counts);

    const recap = this.recapCounters.get(collectionId) ?? emptyCounters();
    recap[kind] += 1;
    this.recapCounters.set(collectionId, recap);
  }

  private addRecapVolume(collectionId: string, valueNative: number): void {
    const recap = this.recapCounters.get(collectionId) ?? emptyCounters();
    recap.salesVolumeNative += valueNative;
    this.recapCounters.set(collectionId, recap);
  }

  constructor(options: BidLeadMonitorOptions) {
    this.onLead = options.onLead;
    this.onWatchedChange = options.onWatchedChange;
    this.onNewListing = options.onNewListing;
    this.onTrendAlert = options.onTrendAlert;
    this.onTrendAlertWithChart = options.onTrendAlertWithChart;
    this.onSale = options.onSale;
    this.onListingRecurrence = options.onListingRecurrence;
    this.onWatchedSold = options.onWatchedSold;
    this.onWatchedDelisted = options.onWatchedDelisted;
    this.onWhaleActivity = options.onWhaleActivity;
    this.onRecap = options.onRecap;
    this.onHighestOffer = options.onHighestOffer;
    this.highestOfferStore = options.highestOfferStore ?? new HighestOfferStore(HIGHEST_OFFER_STORE_PATH);
    this.seenStore = options.seenStore ?? new SeenStore(SEEN_STORE_PATH);
    this.listingAnchorStore = options.listingAnchorStore ?? new ListingAnchorStore(LISTING_ANCHOR_STORE_PATH);
    this.watchStore = options.watchStore ?? new WatchStore(WATCH_STORE_PATH);
    this.whaleStore = options.whaleStore ?? new WhaleStore(WHALE_STORE_PATH);
    this.historyStore = options.historyStore ?? new FloorHistoryStore(HISTORY_STORE_PATH);

    this.watchlistConfig = loadWatchlistConfig(config.WATCHLIST_CONFIG_PATH);
    // Global /config overrides live in watchlist.json and must be in effect
    // before anything reads a tunable (see src/config/runtime.ts).
    applySettingsOverrides(this.watchlistConfig.settings);
    this.collections = getAllowlistedCollectionIds(this.watchlistConfig);

    for (const id of this.collections) {
      this.state.set(id, {
        seenListingIds: this.seenStore.getListingIds(id),
        seenSaleIds: this.seenStore.getSaleIds(id),
        lastFloorPrice: null,
        lastFloorName: null,
      });
    }

    if (this.collections.length === 0) {
      console.warn("[bid-leads] No enabled watchlist.json entries — bid-lead generation is idle until you add some.");
    }
  }

  // --- Whale tracking (Group 3.2) ---------------------------------------

  /** `/whale add`. Alerts are emitted ONLY for activity inside allowlisted collections — see checkWhaleActivity. */
  addWhale(address: string, label?: string): { ok: boolean; message: string } {
    return this.whaleStore.add(address, label);
  }

  /** `/whale remove`. */
  removeWhale(address: string): { ok: boolean; message: string } {
    return this.whaleStore.remove(address);
  }

  /** `/whale list`. */
  getWhales(): WhaleWallet[] {
    return this.whaleStore.getAll();
  }

  getAllowlistedCollections(): string[] {
    return [...this.collections];
  }

  /** Full allowlist entries (not just collection IDs) — used by /watchlist list. */
  getEntries(): AllowlistEntry[] {
    return [...this.watchlistConfig.entries];
  }

  /** Called by the Discord bot's 👀 watch handler to track a specific token for future price-change/sold/delisted alerts. Persisted — survives restarts. */
  addWatchedSubject(collectionId: string, collectionName: string, tokenId: string, currentPriceNative: number, currentPriceCurrency: string): void {
    this.watchStore.add({
      collectionId,
      collectionName,
      tokenId,
      lastKnownPriceNative: currentPriceNative,
      lastKnownPriceCurrency: currentPriceCurrency,
      addedAt: new Date().toISOString(),
      missingTicks: 0,
    });
  }

  /** Called by /watching remove. Returns false if the token wasn't being watched. */
  removeWatchedSubject(collectionId: string, tokenId: string): boolean {
    return this.watchStore.remove(collectionId, tokenId);
  }

  /** Every currently-watched token, across all collections — used by /watching list. */
  getWatchedItems(): WatchedItem[] {
    return this.watchStore.getAll();
  }

  /**
   * Re-reads watchlist.json from disk and applies the diff in place —
   * called after /watchlist add|remove writes a change, so it takes effect
   * immediately without dropping the gateway connection or restarting the
   * process. Newly-added collections get an immediate poll rather than
   * waiting up to an hour; removed collections' in-memory state is dropped.
   */
  reload(): void {
    const newConfig = loadWatchlistConfig(config.WATCHLIST_CONFIG_PATH);
    const newCollections = getAllowlistedCollectionIds(newConfig);
    const added = newCollections.filter((id) => !this.collections.includes(id));
    const removed = this.collections.filter((id) => !newCollections.includes(id));

    for (const id of removed) {
      this.state.delete(id);
      this.lastTrendFloor.delete(id);
      this.recapCounters.delete(id);
      this.historyStore.forget(id);
      this.highestOfferStore.forget(id); // re-added later re-baselines rather than comparing against a stale high
      this.seenStore.forget(id); // if re-added later, it re-baselines from scratch rather than acting on years-stale dedupe state
    }
    for (const id of added) {
      this.state.set(id, {
        seenListingIds: this.seenStore.getListingIds(id),
        seenSaleIds: this.seenStore.getSaleIds(id),
        lastFloorPrice: null,
        lastFloorName: null,
      });
    }

    this.watchlistConfig = newConfig;
    this.collections = newCollections;
    // Re-apply /config overrides — a reload follows every `/config set`, and
    // this is what makes the new value take effect process-wide immediately.
    applySettingsOverrides(newConfig.settings);
    console.log(`[bid-leads] Reloaded watchlist.json — now watching ${this.collections.length} collection(s).`);

    for (const id of added) void this.pollCollection(id);

    // A /config change to trend_alert_times or daily_recap_time only takes
    // effect once the old timers are torn down and rebuilt against the new
    // schedule — without this, the change would silently not apply until the
    // next process restart.
    this.rescheduleDigests();
    this.ensureTimersRunning();
  }

  /** Drops and rebuilds the trend + recap schedules, so an edited schedule applies immediately. */
  private rescheduleDigests(): void {
    for (const t of this.trendTimers) clearTimeout(t);
    this.trendTimers = [];
    if (this.recapTimer) {
      clearTimeout(this.recapTimer);
      this.recapTimer = null;
    }
    this.startTrendSchedule();
    this.startRecapSchedule();
  }

  /** Seconds since this monitor (i.e. the process) started. Used by /status. */
  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /** ISO timestamp the last poll cycle finished, or null if none has completed yet. Used by /status. */
  getLastPollAt(): string | null {
    return this.lastPollCompletedAt;
  }

  /** ISO timestamp the last twice-daily trend/floor-move check ran, or null if none has fired yet. Used by /status. */
  getLastTrendCheckAt(): string | null {
    return this.lastTrendCheckAt;
  }

  /** Per-collection new-listing/sale/bid-lead counts since the process started. Used by /status. */
  getActivitySummary(): Array<{ label: string; listings: number; sales: number; leads: number }> {
    return this.collections.map((id) => {
      const counts = this.activityCounts.get(id) ?? { listings: 0, sales: 0, leads: 0 };
      const entry = this.watchlistConfig.entries.find((e) => e.collection.toLowerCase() === id.toLowerCase());
      return { label: entry?.label ?? id, ...counts };
    });
  }

  /** ISO timestamp the last daily recap posted, or null if none has fired yet. Used by /status. */
  getLastRecapAt(): string | null {
    return this.lastRecapAt;
  }

  /** Soonest upcoming daily-recap firing, or null if it isn't configured/parseable. Used by /status. */
  getNextRecapTime(): Date | null {
    try {
      const times = parseTrendAlertTimes(getDailyRecapTime());
      if (times.length === 0) return null;
      const now = new Date();
      return new Date(now.getTime() + msUntilNext(times[0]!, now));
    } catch {
      return null;
    }
  }

  /** Soonest upcoming trend-digest firing, or null if none are configured/parseable. Used by /status. */
  getNextTrendCheckTime(): Date | null {
    try {
      const times = parseTrendAlertTimes(getTrendAlertTimes());
      if (times.length === 0) return null;
      const now = new Date();
      const soonestMs = Math.min(...times.map((t) => msUntilNext(t, now)));
      return new Date(now.getTime() + soonestMs);
    } catch {
      return null;
    }
  }

  /** Milliseconds between starting each collection's poll. The request scheduler (opensea/requestScheduler.ts) is what actually enforces the rate-limit budget regardless of timing, but staggering start times keeps a fresh poll cycle from queueing every collection's floor/listings/sales calls in the same instant, which just piles up latency at the front of the queue for no benefit. */
  private static readonly POLL_STAGGER_MS = 1500;

  async pollOnce(): Promise<void> {
    await Promise.all(this.collections.map((id, index) => this.staggeredPoll(id, index * BidLeadMonitor.POLL_STAGGER_MS)));
    this.lastPollCompletedAt = new Date().toISOString();
  }

  private async staggeredPoll(collectionId: string, delayMs: number): Promise<void> {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await this.pollCollection(collectionId);
  }

  start(): void {
    this.ensureTimersRunning();
  }

  /** Starts the poll interval (if not already running and there's something to poll) and the trend schedule. Idempotent — safe to call from both start() and reload(). */
  private ensureTimersRunning(): void {
    if (!this.timer && this.collections.length > 0) {
      void this.pollOnce();
      this.timer = setInterval(() => void this.pollOnce(), config.POLL_INTERVAL_SECONDS * 1000);
    }
    this.startTrendSchedule();
    this.startRecapSchedule();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const t of this.trendTimers) clearTimeout(t);
    this.trendTimers = [];
    if (this.recapTimer) {
      clearTimeout(this.recapTimer);
      this.recapTimer = null;
    }
  }

  private async pollCollection(collectionId: string): Promise<void> {
    const state = this.state.get(collectionId);
    if (!state) return;

    try {
      const [floor, listings, sales, ethUsdRate] = await Promise.all([
        openseaClient.getFloorPrice(collectionId),
        openseaClient.getRecentListings(collectionId, 10),
        openseaClient.getRecentSales(collectionId, 10),
        openseaClient.getEthUsdRate(),
      ]);

      const floorMovePercent =
        state.lastFloorPrice !== null && state.lastFloorPrice !== 0
          ? ((floor.floorPriceNative - state.lastFloorPrice) / state.lastFloorPrice) * 100
          : undefined;
      state.lastFloorPrice = floor.floorPriceNative;
      state.lastFloorName = floor.name;

      // Record the floor/volume reading this tick ALREADY fetched — the
      // series behind the trend chart and the daily recap costs no extra
      // OpenSea calls.
      this.historyStore.record(collectionId, {
        t: new Date().toISOString(),
        floor: floor.floorPriceNative,
        volume: floor.volume24hNative,
      });

      // This collection's very first poll ever (nothing persisted for it in
      // seenStore) establishes a silent baseline instead of treating
      // everything currently on the market as "new" — otherwise every
      // restart would re-fetch the same handful of listings/sales and post
      // them as if they just happened (a backfill burst, not a real
      // signal). Sales get a small exception: genuinely recent ones
      // (within SALES_LOOKBACK_MINUTES) still post even on this first poll,
      // so a restart doesn't silently swallow something that just sold.
      const isBaselinePoll = this.seenStore.isNewCollection(collectionId);
      const saleLookbackCutoffMs = Date.now() - config.SALES_LOOKBACK_MINUTES * 60_000;

      // One token can carry SEVERAL concurrent orders at near-identical
      // prices, so decisions are made per TOKEN against its cheapest active
      // listing — never per order hash, which is what used to make the
      // anchor alternate between two prices and emit an endless ▼/▲
      // "Price change" flip-flop. See lowestListing.ts.
      const activeListings = selectLowestListingPerToken(listings);

      // Every observed order hash is still recorded (not just the cheapest),
      // so restart-safety and the baseline check see the full picture.
      const alreadySeen = new Set(state.seenListingIds);
      for (const listing of listings) state.seenListingIds.add(listing.id);
      if (state.seenListingIds.size > 1000) state.seenListingIds.clear();

      const newSales = isBaselinePoll
        ? sales.filter((s) => new Date(s.createdAt).getTime() >= saleLookbackCutoffMs)
        : sales.filter((s) => !state.seenSaleIds.has(s.id));
      for (const sale of sales) state.seenSaleIds.add(sale.id);
      if (state.seenSaleIds.size > 1000) state.seenSaleIds.clear();

      this.seenStore.recordSeen(collectionId, {
        listingIds: listings.map((l) => l.id),
        saleIds: sales.map((s) => s.id),
      });

      for (const sale of newSales) await this.emitSale(sale, floor.name, ethUsdRate);

      await this.checkWatchedSubjects(collectionId, floor.name, listings, sales);

      // Whale scan reads the SAME listings/sales already in hand — strictly
      // allowlist-scoped by construction, and zero additional API calls.
      // Listings are the ones whose order hash we've genuinely never seen
      // (empty on a baseline poll, so a restart never replays old whale
      // listings); whale SALES still flow on a baseline poll, bounded by the
      // same SALES_LOOKBACK_MINUTES window as regular sales.
      const newlySeenListings = isBaselinePoll ? [] : activeListings.filter((l) => !alreadySeen.has(l.id));
      await this.checkWhaleActivity(collectionId, floor.name, newlySeenListings, newSales, ethUsdRate);

      if (isBaselinePoll) return; // first-ever poll only establishes the seen baseline — never posts

      // Classify each token by comparing its CHEAPEST active listing against
      // the anchor we have on record for it:
      //   - anchor matches that price   -> recurrence (thread status update)
      //   - anchor exists, price moved  -> genuine price change (repost)
      //   - no anchor, order never seen -> genuinely new listing
      //   - no anchor, order seen befor -> pre-existing at baseline; stays
      //     silent, so a restart never backfills.
      const recurrences: ListingInfo[] = [];
      const actionable: ListingInfo[] = [];

      for (const listing of activeListings) {
        const anchor = this.listingAnchorStore.get(listing.collectionId, listing.tokenId);

        if (anchor) {
          const sameCurrency = anchor.priceCurrency === listing.priceCurrency;
          const movePercent =
            sameCurrency && anchor.price > 0 ? Math.abs((listing.priceNative - anchor.price) / anchor.price) * 100 : Number.POSITIVE_INFINITY;

          // Unchanged, or a sub-threshold nudge from a listing ladder:
          // refresh the thread status but don't repost, and leave the anchor
          // where it is so cumulative drift still reports eventually.
          if (anchor.price === listing.priceNative && sameCurrency) recurrences.push(listing);
          else if (movePercent < config.PRICE_CHANGE_MIN_PERCENT) recurrences.push(listing);
          else actionable.push(listing);
          continue;
        }

        // No anchor: only a listing we've genuinely never seen is news. One
        // we saw during the baseline poll (or before an outage) is
        // pre-existing and must stay silent.
        if (!alreadySeen.has(listing.id)) actionable.push(listing);
      }

      for (const listing of recurrences) {
        const { imageUrl } = await openseaClient.getNftDetails(listing.collectionId, listing.tokenId);
        await this.emitListingRecurrence(listing, floor.name, imageUrl, ethUsdRate);
      }

      // ONE offers read per tick, shared by both consumers below. Previously
      // this was fetched only when something was actionable, and only for
      // the above-market check; #highest-offers needs it every tick, and
      // sharing the result means the two features cost one call between
      // them rather than one each.
      const offers = this.onHighestOffer || actionable.length > 0 ? await this.fetchCollectionOffers(collectionId) : [];

      await this.checkHighestOffer(collectionId, floor, offers, ethUsdRate);

      const collectionScoped = offers.filter((o) => o.scope === "collection");
      const topCollectionOfferNative = collectionScoped.length > 0 ? Math.max(...collectionScoped.map((o) => o.priceNative)) : undefined;

      for (const listing of actionable) {
        const [{ imageUrl, traits }, lastSale] = await Promise.all([
          openseaClient.getNftDetails(listing.collectionId, listing.tokenId),
          openseaClient.getLastSaleForToken(listing.collectionId, listing.tokenId),
        ]);

        await this.emitNewListing(listing, floor, imageUrl, ethUsdRate);

        const candidate = this.buildCandidate(listing, floor, floorMovePercent, actionable.length, imageUrl, traits, ethUsdRate, lastSale);
        const match = evaluateCandidate(candidate, this.watchlistConfig, this.limiter);
        if (match) {
          await this.onLead(match, candidate);
          this.bumpActivity(listing.collectionId, "leads");
        }

        await this.checkAboveMarketOffer(candidate, topCollectionOfferNative);
      }
    } catch (err) {
      console.error(`[bid-leads] failed to poll collection ${collectionId}: ${(err as Error).message}`);
    }
  }

  /**
   * Posts a fresh top-level #new-listings message — either a genuinely new
   * listing for this token, or (if we have a prior anchor on record with a
   * different price) a flagged price-change update. Either way this token's
   * anchor is replaced with the freshly-posted message, dropping any old
   * thread — a new top-level message needs its own thread, lazily created
   * on the next recurrence/price-change (see emitListingRecurrence).
   */
  private async emitNewListing(
    listing: ListingInfo,
    floor: CollectionInfo,
    imageUrl: string | undefined,
    ethUsdRate: number | undefined,
  ): Promise<void> {
    if (!this.onNewListing) return;
    if (listing.priceNative > getNewListingMaxPrice()) return;

    const priorAnchor = this.listingAnchorStore.get(listing.collectionId, listing.tokenId);
    const isPriceChange =
      priorAnchor !== undefined && (priorAnchor.price !== listing.priceNative || priorAnchor.priceCurrency !== listing.priceCurrency);

    const now = new Date();
    let title: string;
    let message: string;
    const data: Record<string, unknown> = {
      tokenId: listing.tokenId,
      price: listing.priceNative,
      currency: listing.priceCurrency,
      source: listing.source,
      listingId: listing.id,
    };

    const priceText = formatPriceWithUsd(listing.priceNative, listing.priceCurrency, { ethUsdRate });

    if (isPriceChange) {
      const delta = listing.priceNative - priorAnchor!.price;
      const arrow = delta > 0 ? "▲" : "▼";
      const percent = priorAnchor!.price > 0 ? (delta / priorAnchor!.price) * 100 : 0;
      const priorPriceText = formatPriceWithUsd(priorAnchor!.price, priorAnchor!.priceCurrency, { ethUsdRate });
      title = `${arrow} Price change — ${floor.name} #${listing.tokenId}`;
      message = `Token ${listing.tokenId} relisted at ${priceText} (was ${priorPriceText}, ${arrow} ${Math.abs(percent).toFixed(1)}%) on ${listing.source}.`;
      data.previousPrice = priorAnchor!.price;
    } else {
      title = `New listing — ${floor.name}`;
      message = `Token ${listing.tokenId} listed for ${priceText} on ${listing.source}.`;
    }

    const messageId = await this.onNewListing({
      title,
      message,
      severity: isPriceChange ? "warning" : "info",
      collectionId: listing.collectionId,
      data,
      kind: isPriceChange ? "price-change" : "new-listing",
      imageUrl,
      timestamp: now.toISOString(),
    });

    if (messageId) {
      this.listingAnchorStore.set(listing.collectionId, listing.tokenId, {
        messageId,
        price: listing.priceNative,
        priceCurrency: listing.priceCurrency,
      });
      this.bumpActivity(listing.collectionId, "listings");
    }
  }

  /**
   * A still-active, unsold listing (same token, same price — see
   * pollCollection) gets a single living "still listed" status message
   * (with the NFT image) threaded onto its original #new-listings message,
   * updated in place on every recurrence rather than reposted — see
   * ListingRecurrenceHandler. No-op if we have no anchor on record for this
   * token (e.g. it predates this feature, or was never posted in the first
   * place — priced above NEW_LISTING_MAX_PRICE).
   */
  private async emitListingRecurrence(
    listing: ListingInfo,
    collectionName: string,
    imageUrl: string | undefined,
    ethUsdRate: number | undefined,
  ): Promise<void> {
    if (!this.onListingRecurrence) return;

    const anchor = this.listingAnchorStore.get(listing.collectionId, listing.tokenId);
    if (!anchor) return;
    // NOTE: the listing's price may legitimately differ slightly from the
    // anchor's — a sub-PRICE_CHANGE_MIN_PERCENT ladder nudge is routed here
    // rather than reposted (see pollCollection). The status embed renders
    // the CURRENT price, so the thread stays accurate while the anchor
    // deliberately lags at the last *reported* price.

    const seenCount = (anchor.seenCount ?? 1) + 1;
    const lastSeenAt = new Date().toISOString();

    const result = await this.onListingRecurrence({
      tokenId: listing.tokenId,
      collectionName,
      anchorMessageId: anchor.messageId,
      existingThreadId: anchor.threadId,
      existingStatusMessageId: anchor.statusMessageId,
      priceNative: listing.priceNative,
      priceCurrency: listing.priceCurrency,
      imageUrl,
      seenCount,
      lastSeenAt,
      ethUsdRate,
    });

    if (result) {
      this.listingAnchorStore.updateRecurrence(listing.collectionId, listing.tokenId, {
        threadId: result.threadId,
        statusMessageId: result.statusMessageId,
        seenCount,
      });
    }
  }

  /**
   * Posts a completed sale to #watchlist-sales. Routed through the same
   * per-entry LeadLimiter as bid leads/offers — the seenSaleIds set already
   * prevents reposting the same sale, but the rate limit is a backstop
   * against a genuine burst of sales flooding the channel. Uses its own
   * dedupe-key namespace (`sale:...`) so it can't collide with regular
   * bid-lead or above-market-offer dedupe state for the same token.
   */
  private async emitSale(sale: SaleInfo, collectionName: string, ethUsdRate: number | undefined): Promise<void> {
    if (!this.onSale) return;

    const entry = this.watchlistConfig.entries.find(
      (e) => e.enabled && e.collection.toLowerCase() === sale.collectionId.toLowerCase(),
    );
    if (!entry) return; // structurally shouldn't happen — sales are only ever fetched for allowlisted collections — but keep the same allowlist-only posture as the rest of the pipeline

    const dedupeKey = `sale:${sale.collectionId}:${sale.id}`;
    const suppressReason = this.limiter.check(entry, dedupeKey);
    if (suppressReason) return;
    this.limiter.recordFired(entry, dedupeKey);

    await this.onSale(sale, collectionName, ethUsdRate);
    this.bumpActivity(sale.collectionId, "sales");
    this.addRecapVolume(sale.collectionId, sale.priceNative);
  }

  /**
   * Alerts when a `/whale add`-marked wallet buys, sells, or lists inside an
   * ALLOWLISTED collection (Group 3.2).
   *
   * Scoping: this is only ever called from pollCollection, over the listings
   * and sales already fetched for a collection that is on the allowlist by
   * construction — so a marked wallet's activity anywhere else is
   * structurally invisible here, not merely filtered out. It also costs no
   * additional OpenSea reads.
   *
   * Dedupe + throttle: routed through the same per-entry LeadLimiter as bid
   * leads, under its own `whale:` key namespace so it can never suppress (or
   * be suppressed by) a regular lead, sale, or offer for the same token. The
   * key includes the specific event ID, so a genuinely new event always gets
   * through while a re-observed one never double-posts. Entry mute and quiet
   * hours apply, same as every other signal.
   */
  private async checkWhaleActivity(
    collectionId: string,
    collectionName: string,
    listings: ListingInfo[],
    sales: SaleInfo[],
    ethUsdRate: number | undefined,
  ): Promise<void> {
    if (!this.onWhaleActivity || this.whaleStore.size === 0) return;

    const entry = this.watchlistConfig.entries.find((e) => e.enabled && e.collection.toLowerCase() === collectionId.toLowerCase());
    if (!entry) return; // not allowlisted — cannot happen via pollCollection, but keeps the allowlist-only posture explicit

    const emit = async (activity: WhaleActivity, eventId: string): Promise<void> => {
      const dedupeKey = `whale:${activity.wallet.address}:${activity.action}:${collectionId}:${activity.tokenId}:${eventId}`;
      if (this.limiter.check(entry, dedupeKey)) return;
      this.limiter.recordFired(entry, dedupeKey);
      await this.onWhaleActivity!(activity);
    };

    for (const sale of sales) {
      const buyer = this.whaleStore.get(sale.buyer);
      if (buyer) {
        await emit(
          {
            wallet: buyer,
            action: "bought",
            collectionId,
            collectionName,
            tokenId: sale.tokenId,
            priceNative: sale.priceNative,
            priceCurrency: sale.priceCurrency,
            timestamp: sale.createdAt,
            transactionHash: sale.transactionHash,
            imageUrl: sale.imageUrl,
            counterparty: sale.seller,
            ethUsdRate,
          },
          sale.id,
        );
      }

      const seller = this.whaleStore.get(sale.seller);
      if (seller) {
        await emit(
          {
            wallet: seller,
            action: "sold",
            collectionId,
            collectionName,
            tokenId: sale.tokenId,
            priceNative: sale.priceNative,
            priceCurrency: sale.priceCurrency,
            timestamp: sale.createdAt,
            transactionHash: sale.transactionHash,
            imageUrl: sale.imageUrl,
            counterparty: sale.buyer,
            ethUsdRate,
          },
          sale.id,
        );
      }
    }

    for (const listing of listings) {
      const lister = this.whaleStore.get(listing.seller);
      if (!lister) continue;
      await emit(
        {
          wallet: lister,
          action: "listed",
          collectionId,
          collectionName,
          tokenId: listing.tokenId,
          priceNative: listing.priceNative,
          priceCurrency: listing.priceCurrency,
          timestamp: listing.createdAt,
          ethUsdRate,
        },
        listing.id,
      );
    }
  }

  /** All active offers (collection / trait / item scoped) for a collection. Never throws — a failed read degrades to "no offers this tick". */
  private async fetchCollectionOffers(collectionId: string): Promise<CollectionOfferInfo[]> {
    try {
      return await openseaClient.getCollectionOffers(collectionId, 20);
    } catch (err) {
      console.warn(`[offers] failed to fetch collection offers for ${collectionId}: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * #highest-offers: posts ONLY when a collection's top offer sets a new
   * record. Reads the offers array this tick already fetched, so it adds no
   * call of its own.
   *
   * "Highest" is the max across every scope OpenSea reports — collection,
   * trait, and item — because the headline number a watcher cares about is
   * the best anyone will currently pay for anything in the collection.
   *
   * No-backfill: a collection with no stored record baselines SILENTLY, the
   * same posture as listings/sales, so a restart (or adding a collection)
   * never dumps the existing high as though it just appeared. See
   * decideHighestOffer for the full rule set, including why an expired
   * record re-baselines instead of posting.
   */
  private async checkHighestOffer(
    collectionId: string,
    floor: CollectionInfo,
    offers: CollectionOfferInfo[],
    ethUsdRate: number | undefined,
  ): Promise<void> {
    if (!this.onHighestOffer) return;

    const entry = this.watchlistConfig.entries.find((e) => e.enabled && e.collection.toLowerCase() === collectionId.toLowerCase());
    if (!entry) return; // allowlist-only, same posture as every other emission path

    // One decision per scope present this tick — collection-wide, each
    // trait, and item offers are independent markets with their own records.
    const decisions = decideHighestOffers(offers, this.highestOfferStore.getForCollection(collectionId));

    for (const decision of decisions) {
      if (decision.action === "none") continue;

      if (decision.action === "baseline") {
        this.highestOfferStore.set(collectionId, decision.scopeKey, decision.record);
        console.log(
          `[highest-offer] Baselined ${floor.name} [${decision.scopeKey}] at ${decision.record.priceNative} ` +
            `${decision.record.priceCurrency} (${decision.reason}) — recorded WITHOUT posting.`,
        );
        continue;
      }

      // Rate-limited/deduped through the same per-entry limiter as every
      // other signal, under its own key namespace so it can never suppress
      // (or be suppressed by) leads, sales, offers, or whale activity. The
      // scope key is part of the dedupe key so a collection record and a
      // trait record can both fire on the same tick.
      const dedupeKey = `highest-offer:${collectionId}:${decision.scopeKey}:${decision.record.offerId}`;
      if (this.limiter.check(entry, dedupeKey)) continue;
      this.limiter.recordFired(entry, dedupeKey);

      this.highestOfferStore.set(collectionId, decision.scopeKey, decision.record);

      // Image source depends on scope: an item offer is about ONE token, so
      // it shows that token's art; trait and collection offers apply to many
      // items, so the collection image is the only honest illustration.
      let imageUrl: string | undefined;
      if (decision.record.scope === "token" && decision.record.tokenId) {
        imageUrl = await openseaClient.getNftImage(collectionId, decision.record.tokenId).catch(() => undefined);
      }
      const collectionImage = await openseaClient.getCollectionImage(collectionId).catch(() => null);

      console.log(
        `[highest-offer] NEW RECORD for ${floor.name} [${decision.scopeKey}]: ${decision.record.priceNative} ` +
          `${decision.record.priceCurrency} (was ${decision.previous.priceNative}).`,
      );

      await this.onHighestOffer({
        collectionId,
        collectionName: floor.name,
        collectionImageUrl: collectionImage?.imageUrl,
        itemImageUrl: imageUrl,
        record: decision.record,
        previous: decision.previous,
        ethUsdRate,
      });
    }
  }

  /**
   * Flags a freshly-listed token's best available offer as a highlighted bid
   * lead when it's a trait/token-scoped offer that beats the top collection-
   * wide offer by at least OFFER_ABOVE_COLLECTION_THRESHOLD_PERCENT — a
   * stronger, above-market bid worth acting on. Independent of (and doesn't
   * require) a normal watchlist filter match: the offer signal alone is
   * sufficient justification, per the allowlisted entry's own dedupe/rate
   * limit/mute/quiet-hours rules (distinct dedupe key from regular leads so
   * the two flows never suppress each other).
   */
  private async checkAboveMarketOffer(candidate: BidLeadCandidate, topCollectionOfferNative: number | undefined): Promise<void> {
    if (topCollectionOfferNative === undefined || topCollectionOfferNative <= 0) return;

    const entry = this.watchlistConfig.entries.find(
      (e) => e.enabled && e.collection.toLowerCase() === candidate.collectionId.toLowerCase(),
    );
    if (!entry) return;

    const bestOffer = await openseaClient.getBestOfferForToken(candidate.collectionId, candidate.tokenId);
    if (!bestOffer || bestOffer.scope === "collection") return;

    const thresholdMultiplier = 1 + getOfferAboveCollectionThresholdPercent() / 100;
    if (bestOffer.priceNative < topCollectionOfferNative * thresholdMultiplier) return;

    const dedupeKey = `offer:${candidate.collectionId}:${candidate.tokenId}`;
    const suppressReason = this.limiter.check(entry, dedupeKey);
    if (suppressReason) return;
    this.limiter.recordFired(entry, dedupeKey);

    const percentAbove = ((bestOffer.priceNative - topCollectionOfferNative) / topCollectionOfferNative) * 100;
    const scopeDescription =
      bestOffer.scope === "trait" && bestOffer.trait ? `trait offer (${bestOffer.trait.key}: ${bestOffer.trait.value})` : "token offer";
    const bestOfferText = formatPriceWithUsd(bestOffer.priceNative, bestOffer.priceCurrency, { ethUsdRate: candidate.ethUsdRate });
    const topCollectionOfferText = formatPriceWithUsd(topCollectionOfferNative, bestOffer.priceCurrency, { ethUsdRate: candidate.ethUsdRate });

    const match: WatchlistMatch = {
      entry,
      reasoning: [`Above-market ${scopeDescription}: ${bestOfferText} is ${percentAbove.toFixed(1)}% above the ${topCollectionOfferText} top collection offer`],
    };

    const offerCandidate: BidLeadCandidate = {
      ...candidate,
      priceNative: bestOffer.priceNative,
      priceCurrency: bestOffer.priceCurrency,
      percentFromFloor:
        candidate.floorPriceNative > 0
          ? Number((((bestOffer.priceNative - candidate.floorPriceNative) / candidate.floorPriceNative) * 100).toFixed(2))
          : 0,
      listingId: bestOffer.id,
      timestamp: new Date().toISOString(),
    };

    await this.onLead(match, offerCandidate);
  }

  /**
   * Schedules the twice-daily trend/floor-move check for every configured
   * local time (TREND_ALERT_TIMES). Uses recursive setTimeout rather than
   * setInterval so each firing recomputes the next real calendar occurrence
   * (correct across DST/day-length changes) instead of drifting.
   */
  private startTrendSchedule(): void {
    if (this.trendTimers.length > 0 || this.collections.length === 0) return;
    if (!this.onTrendAlert && !this.onTrendAlertWithChart) return;

    let times: TrendTime[];
    try {
      times = parseTrendAlertTimes(getTrendAlertTimes());
    } catch (err) {
      console.error(`[trend-alert] ${(err as Error).message} — trend digest disabled.`);
      return;
    }

    for (const time of times) {
      this.scheduleNextTrendCheck(time);
    }
  }

  /**
   * Schedules the once-daily overnight recap (Group 3.3). Separate schedule
   * and separate channel from the twice-daily trend digest: the digest
   * reports individual floor MOVES as they cross a threshold, while this
   * summarizes the whole preceding window across every watched collection
   * whether or not anything crossed a threshold.
   */
  private startRecapSchedule(): void {
    if (this.recapTimer || this.collections.length === 0 || !this.onRecap) return;

    let time: TrendTime;
    try {
      const parsed = parseTrendAlertTimes(getDailyRecapTime());
      if (parsed.length === 0) return;
      time = parsed[0]!;
    } catch (err) {
      console.error(`[recap] Invalid DAILY_RECAP_TIME (${getDailyRecapTime()}): ${(err as Error).message} — daily recap disabled.`);
      return;
    }

    this.scheduleNextRecap(time);
  }

  private scheduleNextRecap(time: TrendTime): void {
    const delay = msUntilNext(time);
    this.recapTimer = setTimeout(() => {
      void this.runRecap();
      this.scheduleNextRecap(time); // same time tomorrow, recomputed so DST doesn't drift it
    }, delay);
  }

  /**
   * Builds and emits the overnight recap, then resets the per-window
   * counters so the next recap covers only the next window. Charts are
   * rendered locally (src/chart/) and capped so a large watchlist can't
   * produce a 20-image post.
   */
  private async runRecap(): Promise<void> {
    if (!this.onRecap) return;

    try {
      const ethUsdRate = await openseaClient.getEthUsdRate();
      const inputs = this.collections.map((collectionId) => {
        const entry = this.watchlistConfig.entries.find((e) => e.collection.toLowerCase() === collectionId.toLowerCase());
        const samples = this.historyStore.getSince(collectionId, RECAP_WINDOW_HOURS);
        return {
          collectionId,
          label: entry?.label ?? this.state.get(collectionId)?.lastFloorName ?? collectionId,
          currency: "ETH",
          samples,
          counters: this.recapCounters.get(collectionId) ?? emptyCounters(),
        };
      });

      const summary = buildRecapSummary(inputs, RECAP_WINDOW_HOURS, new Date(), ethUsdRate);
      const charts = this.renderChartsFor(inputs, `past ${RECAP_WINDOW_HOURS}h`, MAX_RECAP_CHARTS);

      await this.onRecap(summary, charts);
      this.lastRecapAt = new Date().toISOString();
      this.recapCounters.clear();
    } catch (err) {
      console.error(`[recap] failed to build/post the daily recap: ${(err as Error).message}`);
    }
  }

  /** Renders up to `limit` charts, skipping collections without enough history. Never throws — a chart failure degrades to a text-only post. */
  private renderChartsFor(
    inputs: Array<{ collectionId: string; label: string; currency: string; samples: FloorSample[] }>,
    windowLabel: string,
    limit: number,
  ): Array<{ label: string; png: Buffer }> {
    if (!config.TREND_CHARTS_ENABLED) return [];

    const charts: Array<{ label: string; png: Buffer }> = [];
    for (const input of inputs) {
      if (charts.length >= limit) break;
      try {
        const png = renderFloorChart({
          collectionName: input.label,
          currency: input.currency,
          samples: input.samples,
          windowLabel,
        });
        if (png) charts.push({ label: input.label, png });
      } catch (err) {
        console.warn(`[chart] failed to render chart for ${input.label}: ${(err as Error).message}`);
      }
    }
    return charts;
  }

  private scheduleNextTrendCheck(time: TrendTime): void {
    const delay = msUntilNext(time);
    const timer = setTimeout(() => {
      void this.runTrendCheck();
      this.scheduleNextTrendCheck(time); // reschedule for the same time tomorrow
    }, delay);
    this.trendTimers.push(timer);
  }

  /** Fetches a fresh floor for every allowlisted collection and alerts on moves since the previous scheduled check — never on every poll tick. */
  private async runTrendCheck(): Promise<void> {
    if (!this.onTrendAlert && !this.onTrendAlertWithChart) return;

    this.lastTrendCheckAt = new Date().toISOString();
    await Promise.all(
      this.collections.map(async (collectionId) => {
        try {
          const floor = await openseaClient.getFloorPrice(collectionId);
          const prevFloor = this.lastTrendFloor.get(collectionId);
          this.lastTrendFloor.set(collectionId, floor.floorPriceNative);

          if (prevFloor === undefined || prevFloor === 0) return; // first check just seeds the baseline

          const change = (floor.floorPriceNative - prevFloor) / prevFloor;
          if (Math.abs(change) < getFloorMoveThreshold()) return;

          const direction = change > 0 ? "up" : "down";
          const [collectionImage, trendOffers, ethUsdRate] = await Promise.all([
            openseaClient.getCollectionImage(collectionId),
            this.fetchCollectionOffers(collectionId),
            openseaClient.getEthUsdRate(),
          ]);
          const trendCollectionScoped = trendOffers.filter((o) => o.scope === "collection");
          const topCollectionOfferNative = trendCollectionScoped.length > 0 ? Math.max(...trendCollectionScoped.map((o) => o.priceNative)) : undefined;
          const topOfferText =
            topCollectionOfferNative !== undefined
              ? ` Top collection offer: ${formatPriceWithUsd(topCollectionOfferNative, floor.floorPriceCurrency, { ethUsdRate })}.`
              : "";
          const prevFloorText = formatPriceWithUsd(prevFloor, floor.floorPriceCurrency, { ethUsdRate });
          const newFloorText = formatPriceWithUsd(floor.floorPriceNative, floor.floorPriceCurrency, { ethUsdRate });

          const alert: Alert = {
            title: `Floor price moved ${direction} — ${floor.name}`,
            message: `${floor.name} floor moved ${(change * 100).toFixed(1)}% from ${prevFloorText} to ${newFloorText} (twice-daily check).${topOfferText}`,
            severity: "warning",
            collectionId,
            data: {
              previousFloor: prevFloor,
              newFloor: floor.floorPriceNative,
              percentChange: Number((change * 100).toFixed(2)),
              ...(topCollectionOfferNative !== undefined ? { topCollectionOffer: topCollectionOfferNative } : {}),
            },
            kind: "floor-move",
            thumbnailUrl: collectionImage?.imageUrl ?? undefined,
          };

          if (this.onTrendAlertWithChart) {
            const entry = this.watchlistConfig.entries.find((e) => e.collection.toLowerCase() === collectionId.toLowerCase());
            const [chart] = this.renderChartsFor(
              [
                {
                  collectionId,
                  label: entry?.label ?? floor.name,
                  currency: floor.floorPriceCurrency,
                  samples: this.historyStore.getSince(collectionId, TREND_CHART_WINDOW_HOURS),
                },
              ],
              `past ${TREND_CHART_WINDOW_HOURS}h`,
              1,
            );
            await this.onTrendAlertWithChart(alert, chart);
          } else {
            await this.onTrendAlert!(alert);
          }
        } catch (err) {
          console.error(`[trend-alert] failed to check floor for ${collectionId}: ${(err as Error).message}`);
        }
      }),
    );
  }

  /**
   * Follow-up alerts for 👀-watched tokens, checked every poll tick against
   * this collection's fresh listings + sales:
   *   - **Sold** — the token appears in this tick's sales: fire
   *     onWatchedSold and stop watching it (nothing left to watch).
   *   - **Price change** — the token is still listed but at a different
   *     price than last known: fire onWatchedChange, update the stored price.
   *   - **Likely delisted** — the token hasn't appeared in listings OR
   *     sales for DELIST_THRESHOLD_TICKS consecutive ticks: fire
   *     onWatchedDelisted and stop watching it.
   * Best-effort, same caveat as the rest of the pipeline: `listings`/`sales`
   * are capped-size recent-activity windows, not a full live snapshot.
   */
  private async checkWatchedSubjects(collectionId: string, collectionName: string, listings: ListingInfo[], sales: SaleInfo[]): Promise<void> {
    const watched = this.watchStore.getForCollection(collectionId);
    if (watched.length === 0) return;

    for (const item of watched) {
      const sale = sales.find((s) => s.tokenId === item.tokenId);
      if (sale) {
        this.watchStore.remove(collectionId, item.tokenId);
        await this.onWatchedSold?.(item, sale);
        continue;
      }

      const listing = listings.find((l) => l.tokenId === item.tokenId);
      if (listing) {
        if (listing.priceNative !== item.lastKnownPriceNative || listing.priceCurrency !== item.lastKnownPriceCurrency) {
          const candidate: BidLeadCandidate = {
            collectionId,
            collectionName,
            tokenId: item.tokenId,
            trait: listing.trait,
            priceNative: listing.priceNative,
            priceCurrency: listing.priceCurrency,
            floorPriceNative: this.state.get(collectionId)?.lastFloorPrice ?? listing.priceNative,
            percentFromFloor: 0,
            rank: listing.rank,
            rankPercentile: listing.rankPercentile,
            sellerWallet: listing.seller,
            source: listing.source,
            listingId: listing.id,
            timestamp: new Date().toISOString(),
          };
          await this.onWatchedChange?.(candidate, item.lastKnownPriceNative);
        }
        this.watchStore.update(collectionId, item.tokenId, {
          lastKnownPriceNative: listing.priceNative,
          lastKnownPriceCurrency: listing.priceCurrency,
          missingTicks: 0,
        });
        continue;
      }

      const missingTicks = item.missingTicks + 1;
      if (missingTicks >= DELIST_THRESHOLD_TICKS) {
        this.watchStore.remove(collectionId, item.tokenId);
        await this.onWatchedDelisted?.(item);
      } else {
        this.watchStore.update(collectionId, item.tokenId, { missingTicks });
      }
    }
  }

  private buildCandidate(
    listing: ListingInfo,
    floor: CollectionInfo,
    floorMovePercent: number | undefined,
    listingSpikeCount: number,
    imageUrl?: string,
    traits?: Trait[],
    ethUsdRate?: number,
    lastSale?: SaleInfo | null,
  ): BidLeadCandidate {
    const percentFromFloor =
      floor.floorPriceNative > 0 ? ((listing.priceNative - floor.floorPriceNative) / floor.floorPriceNative) * 100 : 0;

    return {
      collectionId: listing.collectionId,
      collectionName: floor.name,
      tokenId: listing.tokenId,
      trait: listing.trait,
      traits,
      priceNative: listing.priceNative,
      priceCurrency: listing.priceCurrency,
      floorPriceNative: floor.floorPriceNative,
      percentFromFloor: Number(percentFromFloor.toFixed(2)),
      rank: listing.rank,
      rankPercentile: listing.rankPercentile,
      volume24hNative: floor.volume24hNative,
      owners: floor.owners,
      listingsCount: floor.listingsCount,
      floorMovePercent: floorMovePercent !== undefined ? Number(floorMovePercent.toFixed(2)) : undefined,
      listingSpikeCount,
      sellerWallet: listing.seller,
      lastSalePriceNative: lastSale?.priceNative,
      lastSalePriceCurrency: lastSale?.priceCurrency,
      source: listing.source,
      listingId: listing.id,
      timestamp: new Date().toISOString(),
      imageUrl,
      ethUsdRate,
    };
  }
}
