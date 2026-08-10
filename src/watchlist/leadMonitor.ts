import { resolve } from "node:path";
import { config } from "../config/env.js";
import { formatPriceWithUsd, openseaClient } from "../opensea/client.js";
import type { Alert, CollectionInfo, ListingInfo, SaleInfo, Trait } from "../types/index.js";
import type { BidLeadCandidate } from "./candidate.js";
import { evaluateCandidate, type WatchlistMatch } from "./evaluate.js";
import { ListingAnchorStore } from "./listingAnchorStore.js";
import { LeadLimiter } from "./limiter.js";
import { SeenStore } from "./seenStore.js";
import { getAllowlistedCollectionIds, loadWatchlistConfig } from "./store.js";
import type { AllowlistConfig, AllowlistEntry } from "./schema.js";
import { WatchStore, type WatchedItem } from "./watchStore.js";

const SEEN_STORE_PATH = resolve(process.cwd(), ".watchlist-seen-state.json");
const LISTING_ANCHOR_STORE_PATH = resolve(process.cwd(), ".watchlist-listing-anchors.json");
const WATCH_STORE_PATH = resolve(process.cwd(), ".watchlist-watched-items.json");

/** Consecutive poll ticks a watched token can go missing from both recent-listings and recent-sales before it's treated as likely delisted. See WatchedItem.missingTicks for the caveat. */
const DELIST_THRESHOLD_TICKS = 3;

export type BidLeadHandler = (match: WatchlistMatch, candidate: BidLeadCandidate) => void | Promise<void>;
export type WatchedChangeHandler = (candidate: BidLeadCandidate, previousPriceNative: number) => void | Promise<void>;
export type WatchedSoldHandler = (item: WatchedItem, sale: SaleInfo) => void | Promise<void>;
export type WatchedDelistedHandler = (item: WatchedItem) => void | Promise<void>;
export type AlertHandler = (alert: Alert) => void | Promise<void>;
export type SaleHandler = (sale: SaleInfo, collectionName: string, ethUsdRate: number | undefined) => void | Promise<void>;
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
export class BidLeadMonitor {
  private watchlistConfig: AllowlistConfig;
  private collections: string[];
  private readonly state = new Map<string, CollectionRuntimeState>();
  private readonly limiter = new LeadLimiter();
  private readonly seenStore: SeenStore;
  private readonly watchStore: WatchStore;
  /** Floor price recorded at the last twice-daily trend check, per collection — the baseline the next check compares against. */
  private readonly lastTrendFloor = new Map<string, number>();
  private readonly onLead: BidLeadHandler;
  private readonly onWatchedChange: WatchedChangeHandler | undefined;
  private readonly onNewListing: NewListingHandler | undefined;
  private readonly onTrendAlert: AlertHandler | undefined;
  private readonly onSale: SaleHandler | undefined;
  private readonly onListingRecurrence: ListingRecurrenceHandler | undefined;
  private readonly onWatchedSold: WatchedSoldHandler | undefined;
  private readonly onWatchedDelisted: WatchedDelistedHandler | undefined;
  private readonly listingAnchorStore: ListingAnchorStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trendTimers: ReturnType<typeof setTimeout>[] = [];

  /** For /status: process start time, last poll/trend-check completion, and per-collection activity counts — all in-memory, resets on restart same as everything else here. */
  private readonly startedAt = Date.now();
  private lastPollCompletedAt: string | null = null;
  private lastTrendCheckAt: string | null = null;
  private readonly activityCounts = new Map<string, { listings: number; sales: number; leads: number }>();

  private bumpActivity(collectionId: string, kind: "listings" | "sales" | "leads"): void {
    const counts = this.activityCounts.get(collectionId) ?? { listings: 0, sales: 0, leads: 0 };
    counts[kind] += 1;
    this.activityCounts.set(collectionId, counts);
  }

  constructor(
    onLead: BidLeadHandler,
    onWatchedChange?: WatchedChangeHandler,
    onNewListing?: NewListingHandler,
    onTrendAlert?: AlertHandler,
    onSale?: SaleHandler,
    seenStore: SeenStore = new SeenStore(SEEN_STORE_PATH),
    onListingRecurrence?: ListingRecurrenceHandler,
    listingAnchorStore: ListingAnchorStore = new ListingAnchorStore(LISTING_ANCHOR_STORE_PATH),
    onWatchedSold?: WatchedSoldHandler,
    onWatchedDelisted?: WatchedDelistedHandler,
    watchStore: WatchStore = new WatchStore(WATCH_STORE_PATH),
  ) {
    this.onLead = onLead;
    this.onWatchedChange = onWatchedChange;
    this.onNewListing = onNewListing;
    this.onTrendAlert = onTrendAlert;
    this.onSale = onSale;
    this.seenStore = seenStore;
    this.onListingRecurrence = onListingRecurrence;
    this.listingAnchorStore = listingAnchorStore;
    this.onWatchedSold = onWatchedSold;
    this.onWatchedDelisted = onWatchedDelisted;
    this.watchStore = watchStore;
    this.watchlistConfig = loadWatchlistConfig(config.WATCHLIST_CONFIG_PATH);
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
    console.log(`[bid-leads] Reloaded watchlist.json — now watching ${this.collections.length} collection(s).`);

    for (const id of added) void this.pollCollection(id);

    this.ensureTimersRunning();
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

  /** Soonest upcoming trend-digest firing, or null if none are configured/parseable. Used by /status. */
  getNextTrendCheckTime(): Date | null {
    try {
      const times = parseTrendAlertTimes(config.TREND_ALERT_TIMES);
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
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const t of this.trendTimers) clearTimeout(t);
    this.trendTimers = [];
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

      // A listing whose order hash we've already processed before is
      // definitely still active/unsold at the same price — a cheap,
      // reliable "definitely a recurrence" signal. It is NOT, however, the
      // only way a recurrence shows up: OpenSea sometimes reissues a fresh
      // order hash for a token that's still listed at the SAME price (a
      // relist/renewal, not a real event) — confirmed live, this is not
      // theoretical. Those arrive with a brand-new order hash, so they land
      // in `newListings` below, where a second check (against the anchor
      // store's recorded price) catches them before they'd otherwise be
      // misreported as a fresh "New listing" post.
      const newListings = isBaselinePoll ? [] : listings.filter((l) => !state.seenListingIds.has(l.id));
      const recurringListings = isBaselinePoll ? [] : listings.filter((l) => state.seenListingIds.has(l.id));
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

      for (const listing of recurringListings) {
        const { imageUrl } = await openseaClient.getNftDetails(listing.collectionId, listing.tokenId);
        await this.emitListingRecurrence(listing, floor.name, imageUrl, ethUsdRate);
      }

      // Only spend the extra collection-offers read when there's actually
      // something new this tick to compare against it.
      const topCollectionOfferNative =
        newListings.length > 0 ? await this.getTopCollectionOfferPrice(collectionId) : undefined;

      for (const listing of newListings) {
        const [{ imageUrl, traits }, lastSale] = await Promise.all([
          openseaClient.getNftDetails(listing.collectionId, listing.tokenId),
          openseaClient.getLastSaleForToken(listing.collectionId, listing.tokenId),
        ]);

        // A brand-new order hash for a token that already has an anchor at
        // the SAME price is a relist/renewal, not a real new event or a
        // price change — thread it like any other recurrence instead of
        // posting (and misreporting) a fresh "New listing".
        const existingAnchor = this.listingAnchorStore.get(listing.collectionId, listing.tokenId);
        if (existingAnchor && existingAnchor.price === listing.priceNative && existingAnchor.priceCurrency === listing.priceCurrency) {
          await this.emitListingRecurrence(listing, floor.name, imageUrl, ethUsdRate);
          continue;
        }

        await this.emitNewListing(listing, floor, imageUrl, ethUsdRate);

        const candidate = this.buildCandidate(listing, floor, floorMovePercent, newListings.length, imageUrl, traits, ethUsdRate, lastSale);
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
    if (listing.priceNative > config.NEW_LISTING_MAX_PRICE) return;

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
    if (anchor.price !== listing.priceNative || anchor.priceCurrency !== listing.priceCurrency) return; // defensive — shouldn't happen, see pollCollection's comment

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
  }

  /** Highest currently active collection-wide (not trait/token) offer for a collection, or undefined if none/unavailable. */
  private async getTopCollectionOfferPrice(collectionId: string): Promise<number | undefined> {
    try {
      const offers = await openseaClient.getCollectionOffers(collectionId, 20);
      const collectionScoped = offers.filter((o) => o.scope === "collection");
      if (collectionScoped.length === 0) return undefined;
      return Math.max(...collectionScoped.map((o) => o.priceNative));
    } catch (err) {
      console.warn(`[offers] failed to fetch collection offers for ${collectionId}: ${(err as Error).message}`);
      return undefined;
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

    const thresholdMultiplier = 1 + config.OFFER_ABOVE_COLLECTION_THRESHOLD_PERCENT / 100;
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
    if (this.trendTimers.length > 0 || this.collections.length === 0 || !this.onTrendAlert) return;

    let times: TrendTime[];
    try {
      times = parseTrendAlertTimes(config.TREND_ALERT_TIMES);
    } catch (err) {
      console.error(`[trend-alert] ${(err as Error).message} — trend digest disabled.`);
      return;
    }

    for (const time of times) {
      this.scheduleNextTrendCheck(time);
    }
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
    if (!this.onTrendAlert) return;

    this.lastTrendCheckAt = new Date().toISOString();
    await Promise.all(
      this.collections.map(async (collectionId) => {
        try {
          const floor = await openseaClient.getFloorPrice(collectionId);
          const prevFloor = this.lastTrendFloor.get(collectionId);
          this.lastTrendFloor.set(collectionId, floor.floorPriceNative);

          if (prevFloor === undefined || prevFloor === 0) return; // first check just seeds the baseline

          const change = (floor.floorPriceNative - prevFloor) / prevFloor;
          if (Math.abs(change) < config.FLOOR_MOVE_THRESHOLD) return;

          const direction = change > 0 ? "up" : "down";
          const [collectionImage, topCollectionOfferNative, ethUsdRate] = await Promise.all([
            openseaClient.getCollectionImage(collectionId),
            this.getTopCollectionOfferPrice(collectionId),
            openseaClient.getEthUsdRate(),
          ]);
          const topOfferText =
            topCollectionOfferNative !== undefined
              ? ` Top collection offer: ${formatPriceWithUsd(topCollectionOfferNative, floor.floorPriceCurrency, { ethUsdRate })}.`
              : "";
          const prevFloorText = formatPriceWithUsd(prevFloor, floor.floorPriceCurrency, { ethUsdRate });
          const newFloorText = formatPriceWithUsd(floor.floorPriceNative, floor.floorPriceCurrency, { ethUsdRate });

          await this.onTrendAlert!({
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
          });
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
