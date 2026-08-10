import { config } from "../config/env.js";
import type { BidInfo, CollectionInfo, CollectionOfferInfo, CollectionSearchResult, ListingInfo, OfferScope, SaleInfo, Trait, TraitCategory } from "../types/index.js";
import { RequestScheduler, type RateLimitHealth } from "./requestScheduler.js";
import {
  mockBestOfferForToken,
  mockCollectionImage,
  mockCollectionOffers,
  mockCollectionTraits,
  mockDefaultCollections,
  mockEthUsdRate,
  mockFloorPrice,
  mockNftDetails,
  mockRecentBids,
  mockRecentListings,
  mockRecentSales,
  mockResolveCollection,
  mockSearchCollections,
  mockTrendingCollections,
} from "./mockData.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Sale payments in one of these are already USD-denominated, so the native amount doubles as the USD amount — no live FX rate needed/available from this endpoint. */
const STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI"]);

/** Lowercase, hyphenate: "Super Punk World" -> "super-punk-world". A best-effort guess at an OpenSea slug from a display name — not guaranteed to match the real slug. */
function slugifyGuess(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

export interface ResolvedCollection {
  address: string;
  slug: string;
  name: string;
}

/**
 * Thin wrapper around the OpenSea API v2 (https://docs.opensea.io/reference).
 *
 * If OPENSEA_API_KEY is not set, every method transparently falls back to
 * mock data so the rest of the agent (monitor/notify/orders) is runnable
 * with zero external credentials — same posture as before this migration.
 *
 * OpenSea v2 keys most endpoints off a collection **slug**, but the rest of
 * this project (watchlist.json, .env WATCHED_COLLECTIONS, the dashboard)
 * keys everything off EVM contract **addresses**. `resolveSlug()` bridges
 * that gap via GET /chain/{chain}/contract/{address}, cached per address so
 * it's only ever looked up once per collection per process lifetime.
 */
export class OpenSeaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly usingMockData: boolean;

  /** address (lowercased) -> resolution, or null if it failed to resolve (cached so we don't retry every poll). */
  private readonly slugCache = new Map<string, SlugResolution | null>();
  /** address (lowercased) -> in-flight resolution promise, so concurrent callers (getFloorPrice + getRecentListings run via Promise.all) share one request instead of each racing past the cache check and firing their own. */
  private readonly slugResolving = new Map<string, Promise<SlugResolution | null>>();

  /** `${address}:${tokenId}` -> {imageUrl, traits}, or null if unavailable. Permanent for the process lifetime (images/traits essentially never change once minted) — capped so a very long-running process can't grow this unboundedly. */
  private readonly nftDetailsCache = new Map<string, NftDetails | null>();
  private static readonly NFT_DETAILS_CACHE_LIMIT = 2000;

  /** address (lowercased) -> collection image/banner, or null if unavailable. Collection images essentially never change, so this is cached for the process lifetime with no expiry. */
  private readonly collectionImageCache = new Map<string, { imageUrl?: string; bannerImageUrl?: string } | null>();

  /** collection slug (lowercased) -> trait categories, or null if unavailable. Trait catalogs are static per collection, so cached for the process lifetime — this gets hit repeatedly during trait autocomplete as the user types. */
  private readonly traitsCache = new Map<string, TraitCategory[] | null>();

  /** Live ETH/USD spot rate, refreshed at most once per ETH_USD_CACHE_TTL_MS — see getEthUsdRate(). */
  private ethUsdRateCache: { rate: number; fetchedAt: number } | null = null;
  private static readonly ETH_USD_CACHE_TTL_MS = 10 * 60_000; // 10 minutes

  /** address (lowercased) -> floor reading, refreshed at most once per FLOOR_CACHE_TTL_MS — see getFloorPrice(). */
  private readonly floorCache = new Map<string, { value: CollectionInfo; fetchedAt: number }>();
  private static readonly FLOOR_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

  /** Every OpenSea call funnels through this — see requestScheduler.ts for what it buys us (pacing, coalescing, 429 backoff). */
  private readonly scheduler: RequestScheduler;

  constructor() {
    this.baseUrl = config.OPENSEA_BASE_URL.replace(/\/+$/, "");
    this.apiKey = config.OPENSEA_API_KEY;
    this.usingMockData = !config.hasOpenSeaKey;
    this.scheduler = new RequestScheduler(config.OPENSEA_REQUESTS_PER_MINUTE);
  }

  /** Current OpenSea request-scheduler health (budget, queue depth, recent 429s) — see requestScheduler.ts. Powers the /status command. */
  getRateLimitHealth(): RateLimitHealth {
    return this.scheduler.getHealth();
  }

  private async request<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    // Every call is keyed by its full URL and routed through the scheduler
    // — concurrent callers wanting the exact same request share one
    // dispatch, and all calls are paced against OPENSEA_REQUESTS_PER_MINUTE
    // regardless of which method they came from.
    return this.scheduler.schedule(url.toString(), () => this.dispatch<T>(url, path));
  }

  private async dispatch<T>(url: URL, path: string): Promise<T> {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(this.apiKey ? { "X-API-KEY": this.apiKey } : {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
        this.scheduler.recordRateLimited(retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined);
      }
      throw new Error(`OpenSea API ${path} failed: ${res.status} ${res.statusText} ${body}`);
    }

    return res.json() as Promise<T>;
  }

  /** List of collections to watch by default when the user hasn't configured any. */
  defaultWatchedCollections(): string[] {
    return mockDefaultCollections();
  }

  /**
   * Resolves an EVM contract address to its OpenSea collection slug (+ a
   * best-effort display name), via GET /chain/{chain}/contract/{address}.
   * Failures (unlisted contract, network error, etc.) are cached as `null`
   * so a bad address doesn't get re-queried on every poll tick — callers
   * fall back to mock data for that collection when this returns null.
   */
  private async resolveSlug(contractAddress: string): Promise<SlugResolution | null> {
    const key = contractAddress.toLowerCase();
    if (this.slugCache.has(key)) return this.slugCache.get(key)!;

    // getFloorPrice and getRecentListings are called together via
    // Promise.all for the same collection every poll tick; without this,
    // both would see the cache miss simultaneously and each fire its own
    // network request + warning log for the same address.
    const inFlight = this.slugResolving.get(key);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<SlugResolution | null> => {
      try {
        const data = await this.request<OpenSeaContractResponse>(`/chain/${config.CHAIN_NAME}/contract/${contractAddress}`);
        if (!data.collection) throw new Error("contract response had no collection slug");
        // The contract endpoint's `name` is the contract's name, not
        // necessarily the collection's display name — close enough for our
        // purposes without a second call to GET /collections/{slug}.
        const resolution: SlugResolution = { slug: data.collection, name: data.name || data.collection };
        this.slugCache.set(key, resolution);
        return resolution;
      } catch (err) {
        console.warn(`[opensea] failed to resolve collection slug for ${contractAddress}: ${(err as Error).message}`);
        this.slugCache.set(key, null);
        return null;
      } finally {
        this.slugResolving.delete(key);
      }
    })();

    this.slugResolving.set(key, promise);
    return promise;
  }

  /**
   * Resolves user-supplied input — a 0x contract address, an OpenSea slug,
   * or a best-effort display name — to a contract address (the key
   * everything else in this project uses) plus slug/name, for slash
   * commands. Read-only: does not touch watchlist.json.
   *
   * Resolution order:
   *   1. If it looks like an address, resolve it the same way the rest of
   *      the client does (GET /chain/{chain}/contract/{address}).
   *   2. Otherwise, try it as an OpenSea slug directly (GET /collections/{slug}),
   *      then a slugified guess of it (spaces/punctuation -> hyphens) — e.g.
   *      "Azuki" often *is* the slug, but "Super Punk World" is not (the
   *      real slug is "nina-super-punk-world"). OpenSea's v2 API has no
   *      free-text collection search endpoint, so a name that doesn't equal
   *      or naively slugify to the real slug won't resolve — the caller
   *      should tell the user to supply the exact slug or address instead.
   *
   * Returns null if nothing resolves, or if a resolved collection has no
   * Ethereum contract address (nothing to key an allowlist entry on).
   */
  async resolveCollection(input: string): Promise<ResolvedCollection | null> {
    const trimmed = input.trim();
    if (!trimmed) return null;

    if (this.usingMockData) return mockResolveCollection(trimmed);

    if (ADDRESS_RE.test(trimmed)) {
      const resolution = await this.resolveSlug(trimmed);
      if (!resolution) return null;
      return { address: trimmed.toLowerCase(), slug: resolution.slug, name: resolution.name };
    }

    const candidates = [...new Set([trimmed, slugifyGuess(trimmed)])];
    for (const slug of candidates) {
      try {
        const data = await this.request<OpenSeaCollectionResponse>(`/collections/${slug}`);
        const contract = data.contracts?.find((c) => c.chain === config.CHAIN_NAME);
        if (contract?.address) {
          return { address: contract.address.toLowerCase(), slug, name: data.name ?? slug };
        }
      } catch {
        // try the next candidate; a 404 on a guessed slug is expected, not an error worth logging
      }
    }

    return null;
  }

  /**
   * Free-text collection search, via GET /search?query=&asset_types=collection.
   * This endpoint genuinely works — confirmed live for well-known
   * collections (Azuki, Bored Ape Yacht Club, Pudgy Penguins all resolve
   * correctly typing their plain display name) — but coverage is uneven for
   * smaller/lower-profile collections, where only slug-like text matches
   * (the display name alone comes back empty). Used to power /watchlist
   * add's autocomplete; never throws, returns [] on failure or no matches.
   */
  async searchCollections(query: string, limit = 10): Promise<CollectionSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (this.usingMockData) return mockSearchCollections(trimmed, limit);

    try {
      const data = await this.request<OpenSeaSearchResponse>("/search", { query: trimmed, asset_types: "collection", limit });
      return (data.results ?? [])
        .filter((r) => r.type === "collection" && r.collection?.collection)
        .map((r) => ({
          slug: r.collection!.collection!,
          name: r.collection!.name ?? r.collection!.collection!,
          imageUrl: r.collection!.image_url ?? undefined,
        }));
    } catch (err) {
      console.warn(`[opensea] collection search failed for "${trimmed}": ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Trending collections right now, via GET /collections/trending — a
   * browseable fallback for /watchlist add's autocomplete when free-text
   * search comes up empty (see searchCollections' coverage caveat above).
   */
  async getTrendingCollections(limit = 10): Promise<CollectionSearchResult[]> {
    if (this.usingMockData) return mockTrendingCollections(limit);

    try {
      const data = await this.request<OpenSeaCollectionsListResponse>("/collections/trending", { limit });
      return (data.collections ?? [])
        .filter((c) => c.collection)
        .map((c) => ({ slug: c.collection!, name: c.name ?? c.collection!, imageUrl: c.image_url ?? undefined }));
    } catch (err) {
      console.warn(`[opensea] failed to fetch trending collections: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * A collection's real trait categories + their values, via GET
   * /traits/{slug} (get_collection_traits) — powers trait autocomplete for
   * /watchlist create-rule's trait-based conditions. Accepts either a 0x
   * address (resolved to a slug first) or a slug directly. Values within
   * each category are sorted by how common they are (most first) and capped
   * at 100 — some categories have 50+ values and Discord autocomplete only
   * shows 25 anyway. Cached permanently per collection — trait catalogs are
   * static once a collection is fully revealed.
   */
  async getCollectionTraits(collectionIdOrSlug: string): Promise<TraitCategory[]> {
    if (this.usingMockData) return mockCollectionTraits(collectionIdOrSlug);

    const trimmed = collectionIdOrSlug.trim();
    let slug = trimmed;
    if (ADDRESS_RE.test(trimmed)) {
      const resolution = await this.resolveSlug(trimmed);
      if (!resolution) return [];
      slug = resolution.slug;
    }

    const cacheKey = slug.toLowerCase();
    const cached = this.traitsCache.get(cacheKey);
    if (cached !== undefined) return cached ?? [];

    try {
      const data = await this.request<OpenSeaTraitsResponse>(`/traits/${slug}`);
      const counts = data.counts ?? {};
      const categories: TraitCategory[] = Object.entries(counts).map(([key, valueCounts]) => ({
        key,
        values: Object.entries(valueCounts ?? {})
          .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
          .map(([value]) => value)
          .slice(0, 100),
      }));
      this.traitsCache.set(cacheKey, categories);
      return categories;
    } catch (err) {
      console.warn(`[opensea] failed to fetch traits for ${slug}: ${(err as Error).message}`);
      this.traitsCache.set(cacheKey, null);
      return [];
    }
  }

  /**
   * Live ETH/USD spot rate, for the "(~$X)" suffix shown alongside every
   * ETH-denominated price. Cached for ETH_USD_CACHE_TTL_MS (10 min) so
   * embeds/messages never trigger a network call each time one is built.
   *
   * Source order:
   *   1. OpenSea's own GET /chain/{chain}/payment_token/{address} for
   *      native ETH (address 0x0…0), which returns a `usdPrice` field —
   *      confirmed live; kept as primary since it's the same vendor/key
   *      already used for everything else here.
   *   2. CoinGecko's public simple-price endpoint (no key needed), if
   *      OpenSea's call fails for any reason.
   *   3. The last successfully cached rate, even if stale, if BOTH of the
   *      above fail — better than no number if we had one recently.
   *   4. undefined if we've never once had a rate — callers must treat this
   *      as "show ETH only", never fabricate a USD figure.
   * Disabled entirely (always returns undefined) when SHOW_USD=false.
   */
  async getEthUsdRate(): Promise<number | undefined> {
    if (!config.SHOW_USD) return undefined;
    if (this.usingMockData) return mockEthUsdRate();

    const now = Date.now();
    if (this.ethUsdRateCache && now - this.ethUsdRateCache.fetchedAt < OpenSeaClient.ETH_USD_CACHE_TTL_MS) {
      return this.ethUsdRateCache.rate;
    }

    try {
      const data = await this.request<{ usdPrice?: string }>(
        `/chain/${config.CHAIN_NAME}/payment_token/0x0000000000000000000000000000000000000000`,
      );
      const rate = Number(data.usdPrice);
      if (Number.isFinite(rate) && rate > 0) {
        this.ethUsdRateCache = { rate, fetchedAt: now };
        return rate;
      }
      throw new Error(`unexpected usdPrice "${data.usdPrice}"`);
    } catch (err) {
      console.warn(`[opensea] failed to fetch ETH/USD rate from OpenSea, trying CoinGecko: ${(err as Error).message}`);
    }

    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
      if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);
      const json = (await res.json()) as { ethereum?: { usd?: number } };
      const rate = json.ethereum?.usd;
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
        this.ethUsdRateCache = { rate, fetchedAt: now };
        return rate;
      }
      throw new Error("unexpected CoinGecko response shape");
    } catch (err) {
      console.warn(`[opensea] CoinGecko ETH/USD fallback also failed: ${(err as Error).message}`);
    }

    // Never block a post waiting on a fresh rate — fall back to the last
    // known-good one (even if stale past the TTL) rather than showing
    // nothing; undefined only if we've never had one at all.
    return this.ethUsdRateCache?.rate;
  }

  /**
   * Cached for FLOOR_CACHE_TTL_MS (5 min) — floor is read by every poll
   * tick, the twice-daily trend check, /floor, and /watchlist add's
   * preview, none of which need sub-5-minute freshness, so this is the
   * single highest-value cache for staying under the request budget.
   */
  async getFloorPrice(collectionId: string): Promise<CollectionInfo> {
    if (this.usingMockData) return mockFloorPrice(collectionId);

    const key = collectionId.toLowerCase();
    const cached = this.floorCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < OpenSeaClient.FLOOR_CACHE_TTL_MS) {
      return cached.value;
    }

    try {
      const resolution = await this.resolveSlug(collectionId);
      if (!resolution) throw new Error(`could not resolve a collection slug for ${collectionId}`);

      const stats = await this.request<OpenSeaStatsResponse>(`/collections/${resolution.slug}/stats`);
      const oneDay = stats.intervals?.find((i) => i.interval === "one_day");

      const result: CollectionInfo = {
        id: collectionId,
        name: resolution.name,
        floorPriceNative: stats.total?.floor_price ?? 0,
        floorPriceCurrency: stats.total?.floor_price_symbol ?? "ETH",
        chain: config.CHAIN_NAME,
        volume24hNative: oneDay?.volume,
        owners: stats.total?.num_owners,
        // /collections/{slug}/stats doesn't expose an active-listings count;
        // would need a separate call (e.g. counting /listings/collection/{slug}/all
        // pages) that isn't wired up here to keep read calls minimal — the
        // liquidity filter's minListingsCount simply won't match live data
        // until that's added, same fail-closed behavior as missing rarity data.
        listingsCount: undefined,
      };
      this.floorCache.set(key, { value: result, fetchedAt: Date.now() });
      return result;
    } catch (err) {
      // Never fabricate a floor reading for a live-configured collection —
      // a transient failure (rate limit, timeout) here used to silently
      // substitute mock data (wrong name, wrong price) into real posts. But
      // a real, previously-fetched (if now stale) reading is not
      // fabrication — same principle as getEthUsdRate's "reuse the last
      // known-good rate rather than block" — so prefer that over losing
      // the whole poll tick when we have one.
      if (cached) {
        console.warn(
          `[opensea] live floor price call failed for ${collectionId}, using the cached reading from ${new Date(cached.fetchedAt).toISOString()}: ${(err as Error).message}`,
        );
        return cached.value;
      }
      // No cached reading to fall back on — every caller already wraps its
      // poll tick in a try/catch that skips and retries next cycle, so
      // rethrowing is the correct "no data this tick" signal.
      console.warn(`[opensea] live floor price call failed for ${collectionId}, skipping this tick (not fabricating mock data): ${(err as Error).message}`);
      throw err;
    }
  }

  async getRecentListings(collectionId: string, limit = 5): Promise<ListingInfo[]> {
    if (this.usingMockData) return mockRecentListings(collectionId, limit);

    try {
      const resolution = await this.resolveSlug(collectionId);
      if (!resolution) throw new Error(`could not resolve a collection slug for ${collectionId}`);

      const data = await this.request<OpenSeaListingsResponse>(`/listings/collection/${resolution.slug}/all`, { limit });
      return (data.listings ?? []).map((l) => ({
        id: l.order_hash,
        collectionId,
        tokenId: l.asset?.identifier ?? "unknown",
        priceNative: toNativeAmount(l.price?.current?.value, l.price?.current?.decimals),
        priceCurrency: l.price?.current?.currency ?? "ETH",
        seller: l.protocol_data?.parameters?.offerer ?? "unknown",
        source: "opensea",
        createdAt: l.order_created_at ? new Date(l.order_created_at * 1000).toISOString() : new Date().toISOString(),
        // OpenSea's listing objects don't carry trait/rarity metadata
        // directly — a real integration would join in a per-token lookup
        // (GET /listings/nft/{contract}/{tokenId} or get_nfts_by_collection).
        // Left undefined to keep read calls minimal; the watchlist evaluator
        // treats rarity/trait filters as non-matching (not "always pass")
        // when this data is absent, so those filters simply won't fire
        // against the live API until that lookup exists.
        trait: undefined,
        rank: undefined,
        rankPercentile: undefined,
      }));
    } catch (err) {
      // Never fabricate listings for a live-configured collection — a
      // transient failure (rate limit, timeout) skips this tick (empty
      // result reads as "nothing new," which is exactly right) rather than
      // substituting mock tokens/prices/images into a real post.
      console.warn(`[opensea] live listings call failed for ${collectionId}, skipping this tick (not fabricating mock data): ${(err as Error).message}`);
      return [];
    }
  }

  async getRecentBids(collectionId: string, limit = 5): Promise<BidInfo[]> {
    if (this.usingMockData) return mockRecentBids(collectionId, limit);

    try {
      const resolution = await this.resolveSlug(collectionId);
      if (!resolution) throw new Error(`could not resolve a collection slug for ${collectionId}`);

      const data = await this.request<OpenSeaOffersResponse>(`/offers/collection/${resolution.slug}`, { limit });
      return (data.offers ?? []).map((o) => ({
        id: o.order_hash,
        collectionId,
        priceNative: toNativeAmount(o.price?.value, o.price?.decimals),
        priceCurrency: o.price?.currency ?? "ETH",
        bidder: o.protocol_data?.parameters?.offerer ?? "unknown",
        source: "opensea",
        createdAt: o.order_created_at ? new Date(o.order_created_at * 1000).toISOString() : new Date().toISOString(),
      }));
    } catch (err) {
      console.warn(`[opensea] live offers call failed for ${collectionId}, skipping this tick (not fabricating mock data): ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * NFT image + trait list for a specific token, via GET
   * /chain/{chain}/contract/{address}/nfts/{identifier}. Prefers
   * `display_image_url` (OpenSea's rendered/normalized version) over the
   * raw `image_url`. Cached permanently per (address, tokenId) — this data
   * essentially never changes once minted, so there's no reason to re-fetch
   * on every poll. Never throws — a failure degrades to "no image, no
   * traits" rather than breaking the embed or blocking trait-based lead
   * evaluation for every other token.
   *
   * One fetch serves both needs (image display AND trait-based lead
   * matching) so a fresh listing costs exactly one NFT-detail read call,
   * not two.
   */
  async getNftDetails(collectionId: string, tokenId: string): Promise<NftDetails> {
    const key = `${collectionId.toLowerCase()}:${tokenId}`;

    if (this.usingMockData) return mockNftDetails(collectionId, tokenId);

    const cached = this.nftDetailsCache.get(key);
    if (cached !== undefined) return cached ?? { traits: [] };

    try {
      const resolution = await this.resolveSlug(collectionId);
      if (!resolution) throw new Error(`could not resolve a collection slug for ${collectionId}`);

      const data = await this.request<OpenSeaNftResponse>(`/chain/${config.CHAIN_NAME}/contract/${collectionId}/nfts/${tokenId}`);
      const imageUrl = data.nft?.display_image_url || data.nft?.image_url || undefined;
      const traits: Trait[] = (data.nft?.traits ?? [])
        .filter((t): t is { trait_type: string; value: string | number } => t.trait_type !== undefined && t.value !== undefined)
        .map((t) => ({ key: t.trait_type, value: String(t.value) }));
      const result: NftDetails = { imageUrl, traits };

      if (this.nftDetailsCache.size >= OpenSeaClient.NFT_DETAILS_CACHE_LIMIT) this.nftDetailsCache.clear();
      this.nftDetailsCache.set(key, result);
      return result;
    } catch (err) {
      console.warn(`[opensea] failed to fetch NFT details for ${collectionId} #${tokenId}: ${(err as Error).message}`);
      this.nftDetailsCache.set(key, null);
      return { traits: [] };
    }
  }

  /** Convenience wrapper over getNftDetails() for callers that only need the image. */
  async getNftImage(collectionId: string, tokenId: string): Promise<string | undefined> {
    return (await this.getNftDetails(collectionId, tokenId)).imageUrl;
  }

  /**
   * Collection image + banner, via GET /collections/{slug}. Cached
   * permanently (collection images essentially never change). Returns null
   * (never throws) on failure.
   */
  async getCollectionImage(collectionId: string): Promise<{ imageUrl?: string; bannerImageUrl?: string } | null> {
    const key = collectionId.toLowerCase();

    if (this.usingMockData) return mockCollectionImage(collectionId);

    if (this.collectionImageCache.has(key)) return this.collectionImageCache.get(key) ?? null;

    try {
      const resolution = await this.resolveSlug(collectionId);
      if (!resolution) throw new Error(`could not resolve a collection slug for ${collectionId}`);

      const data = await this.request<OpenSeaCollectionResponse>(`/collections/${resolution.slug}`);
      const result = { imageUrl: data.image_url, bannerImageUrl: data.banner_image_url };
      this.collectionImageCache.set(key, result);
      return result;
    } catch (err) {
      console.warn(`[opensea] failed to fetch collection image for ${collectionId}: ${(err as Error).message}`);
      this.collectionImageCache.set(key, null);
      return null;
    }
  }

  /**
   * Collection-scoped offers via GET /offers/collection/{slug}, classified
   * by `scope` from each order's `criteria`:
   *   - "collection": no traits, no encoded_token_ids — applies to any item.
   *   - "trait": criteria.traits is non-empty.
   *   - "token": criteria.encoded_token_ids is present (best-effort; may
   *     resolve to more than one token — OpenSea doesn't decode this for us
   *     without a second call, so treat it as "narrow" rather than exact).
   * This one endpoint covers both "collection offers" and "trait offers" —
   * see getBestOfferForToken() for a true single-NFT offer lookup.
   */
  async getCollectionOffers(collectionId: string, limit = 20): Promise<CollectionOfferInfo[]> {
    if (this.usingMockData) return mockCollectionOffers(collectionId, limit);

    try {
      const resolution = await this.resolveSlug(collectionId);
      if (!resolution) throw new Error(`could not resolve a collection slug for ${collectionId}`);

      const data = await this.request<OpenSeaOffersResponse>(`/offers/collection/${resolution.slug}`, { limit });
      return (data.offers ?? []).map((o) => this.mapOffer(o, collectionId));
    } catch (err) {
      console.warn(`[opensea] live collection-offers call failed for ${collectionId}, skipping this tick (not fabricating mock data): ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * The single best (highest) offer for one specific token, via
   * GET /offers/collection/{slug}/nfts/{identifier}/best. This is the one
   * genuinely single-NFT-specific offer lookup (as opposed to the
   * criteria-based "token" scope in getCollectionOffers, which is
   * best-effort/narrow rather than exact) — kept opportunistic (only called
   * for tokens we already have in hand, e.g. a fresh listing) rather than
   * polled per-token across a whole collection, to keep read calls bounded.
   */
  async getBestOfferForToken(collectionId: string, tokenId: string): Promise<CollectionOfferInfo | null> {
    if (this.usingMockData) return mockBestOfferForToken(collectionId, tokenId);

    try {
      const resolution = await this.resolveSlug(collectionId);
      if (!resolution) throw new Error(`could not resolve a collection slug for ${collectionId}`);

      const data = await this.request<Partial<OpenSeaOffer>>(`/offers/collection/${resolution.slug}/nfts/${tokenId}/best`);
      if (!data.order_hash) return null;
      return this.mapOffer(data as OpenSeaOffer, collectionId, "token");
    } catch (err) {
      // A 404 here just means "no active offer for this token" — normal, not worth warning about.
      if (!/404/.test((err as Error).message)) {
        console.warn(`[opensea] failed to fetch best offer for ${collectionId} #${tokenId}: ${(err as Error).message}`);
      }
      return null;
    }
  }

  /**
   * Recent completed sales for a collection, via GET
   * /events/collection/{slug}?event_type=sale (list_events_by_collection).
   * Deduped by the caller on `${transaction}:${tokenId}` (see leadMonitor.ts)
   * — a transaction hash alone isn't a safe dedupe key since a single tx can
   * in principle settle more than one sale.
   */
  async getRecentSales(collectionId: string, limit = 10): Promise<SaleInfo[]> {
    if (this.usingMockData) return mockRecentSales(collectionId, limit);

    try {
      const resolution = await this.resolveSlug(collectionId);
      if (!resolution) throw new Error(`could not resolve a collection slug for ${collectionId}`);

      const data = await this.request<OpenSeaEventsResponse>(`/events/collection/${resolution.slug}`, {
        event_type: "sale",
        limit,
      });
      return (data.asset_events ?? [])
        .filter((e) => e.event_type === "sale" && e.nft?.identifier !== undefined)
        .map((e) => this.mapSaleEvent(e, collectionId));
    } catch (err) {
      // Never fabricate a sale for a live-configured collection. This was
      // the root cause of a real incident: a transient 429 during sales
      // polling silently substituted mockRecentSales() — correct
      // collectionId, but a fabricated price/buyer/seller AND a
      // Picsum-seeded stock photo (mockNftImage) standing in for the real
      // per-token image, posted to #watchlist-sales as if it were a real
      // sale. Skipping this tick (empty result, dedupe/seenStore untouched
      // so nothing is lost) is the correct behavior — the next hourly poll
      // retries live.
      console.warn(`[opensea] live sales call failed for ${collectionId}, skipping this tick (not fabricating mock data): ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * The most recent completed sale for one specific token, via GET
   * /events/nft/{chain}/{contract}/{tokenId}?event_type=sale&limit=1 — the
   * per-token sibling of getRecentSales' collection-wide events call.
   * Opportunistic (only called for a token already in hand, e.g. a fresh
   * bid-lead candidate), never throws, returns null on any failure
   * (including "this token has never sold," which isn't an error).
   */
  async getLastSaleForToken(collectionId: string, tokenId: string): Promise<SaleInfo | null> {
    if (this.usingMockData) return mockRecentSales(collectionId, 1)[0] ?? null;

    try {
      const data = await this.request<OpenSeaEventsResponse>(`/events/nft/${config.CHAIN_NAME}/${collectionId}/${tokenId}`, {
        event_type: "sale",
        limit: 1,
      });
      const event = (data.asset_events ?? []).find((e) => e.event_type === "sale");
      if (!event) return null;
      return this.mapSaleEvent(event, collectionId);
    } catch (err) {
      if (!/404/.test((err as Error).message)) {
        console.warn(`[opensea] failed to fetch last sale for ${collectionId} #${tokenId}: ${(err as Error).message}`);
      }
      return null;
    }
  }

  private mapSaleEvent(e: OpenSeaSaleEvent, collectionId: string): SaleInfo {
    const priceNative = toNativeAmount(e.payment?.quantity, e.payment?.decimals);
    const priceCurrency = e.payment?.symbol ?? "ETH";

    return {
      // transaction+tokenId, not transaction alone — a single tx can settle more than one sale.
      id: `${e.transaction}:${e.nft?.identifier ?? "unknown"}`,
      collectionId,
      tokenId: e.nft?.identifier ?? "unknown",
      priceNative,
      priceCurrency,
      // OpenSea's events endpoint doesn't return a USD-converted sale price — only
      // populated for stablecoin-denominated sales, where the native amount IS the USD amount.
      priceUsd: STABLECOIN_SYMBOLS.has(priceCurrency.toUpperCase()) ? priceNative : undefined,
      buyer: e.buyer,
      seller: e.seller,
      source: "opensea",
      createdAt: new Date(e.event_timestamp * 1000).toISOString(),
      imageUrl: e.nft?.display_image_url || e.nft?.image_url || undefined,
      transactionHash: e.transaction,
    };
  }

  private mapOffer(o: OpenSeaOffer, collectionId: string, forcedScope?: OfferScope): CollectionOfferInfo {
    const hasTraits = Boolean(o.criteria?.traits && o.criteria.traits.length > 0);
    const hasTokenIds = Boolean(o.criteria?.encoded_token_ids);
    const scope: OfferScope = forcedScope ?? (hasTraits ? "trait" : hasTokenIds ? "token" : "collection");
    const trait = o.criteria?.traits?.[0] ? { key: o.criteria.traits[0].type ?? "trait", value: o.criteria.traits[0].value ?? "" } : undefined;

    return {
      id: o.order_hash,
      collectionId,
      priceNative: toNativeAmount(o.price?.value, o.price?.decimals),
      priceCurrency: o.price?.currency ?? "ETH",
      bidder: o.protocol_data?.parameters?.offerer ?? "unknown",
      source: "opensea",
      createdAt: o.order_created_at ? new Date(o.order_created_at * 1000).toISOString() : new Date().toISOString(),
      scope,
      trait,
    };
  }
}

/** value is a base-unit string (e.g. wei), decimals is typically 18 for ETH/WETH. Precision beyond ~15-17 significant digits is not preserved — fine for display/threshold comparisons, not for constructing transactions. */
function toNativeAmount(value: string | undefined, decimals: number | undefined): number {
  if (!value) return 0;
  const n = Number(value) / 10 ** (decimals ?? 18);
  return Number.isFinite(n) ? n : 0;
}

/** Currencies whose native amount is ETH-pegged 1:1 — safe to multiply by the live ETH/USD rate for a USD estimate. */
const ETH_PEGGED_CURRENCIES = new Set(["ETH", "WETH"]);

/**
 * Formats a native price with a best-effort "(~$X)" USD suffix — using an
 * already-known USD amount if given (e.g. a stablecoin sale, where the
 * native amount already IS the USD amount), otherwise computing one from
 * the live ETH/USD rate for ETH/WETH amounts. Returns just the native
 * amount with no suffix whenever neither is available — this never
 * fabricates a number.
 */
export function formatPriceWithUsd(priceNative: number, priceCurrency: string, options: { ethUsdRate?: number; knownUsd?: number } = {}): string {
  const base = `${priceNative} ${priceCurrency}`;
  const usd =
    options.knownUsd ??
    (options.ethUsdRate !== undefined && ETH_PEGGED_CURRENCIES.has(priceCurrency.toUpperCase()) ? priceNative * options.ethUsdRate : undefined);
  if (usd === undefined || !Number.isFinite(usd)) return base;
  return `${base} (~$${formatUsd(usd)})`;
}

/** Whole dollars for anything $10+, one decimal below that (so a $2.3 sub-floor item doesn't round to a misleading $2). */
function formatUsd(usd: number): string {
  return usd < 10 ? usd.toFixed(1) : Math.round(usd).toLocaleString("en-US");
}

interface SlugResolution {
  slug: string;
  name: string;
}

// --- Minimal shapes for the subset of the OpenSea v2 response we read. ---
// Confirmed against https://docs.opensea.io/reference (get_contract,
// get_collection_stats, get_best_listings_collection/list_listings_collection_all,
// get_offers_collection) — the real API returns considerably more per object.

interface OpenSeaContractResponse {
  address?: string;
  chain?: string;
  collection?: string; // this is the slug
  contract_standard?: string;
  name?: string;
}

interface OpenSeaCollectionResponse {
  name?: string;
  contracts?: Array<{ address?: string; chain?: string }>;
  image_url?: string;
  banner_image_url?: string;
}

interface OpenSeaStatsResponse {
  total?: {
    volume?: number;
    sales?: number;
    num_owners?: number;
    floor_price?: number;
    floor_price_symbol?: string;
  };
  intervals?: Array<{
    interval?: string; // "one_day" | "seven_day" | "thirty_day" | ...
    volume?: number;
    sales?: number;
  }>;
}

interface OpenSeaPrice {
  currency?: string;
  decimals?: number;
  value?: string; // base-unit string, e.g. wei
}

interface OpenSeaProtocolParameters {
  offerer?: string; // maker/bidder address
}

interface OpenSeaListing {
  order_hash: string;
  order_created_at?: number; // unix seconds
  price?: { current?: OpenSeaPrice };
  asset?: { contract?: string; identifier?: string };
  protocol_data?: { parameters?: OpenSeaProtocolParameters };
}

interface OpenSeaListingsResponse {
  listings?: OpenSeaListing[];
  next?: string;
}

interface OpenSeaOfferCriteria {
  traits?: Array<{ type?: string; value?: string }>;
  numeric_traits?: Array<{ type?: string; min?: number; max?: number }>;
  encoded_token_ids?: string;
}

interface OpenSeaOffer {
  order_hash: string;
  order_created_at?: number;
  price?: OpenSeaPrice;
  protocol_data?: { parameters?: OpenSeaProtocolParameters };
  criteria?: OpenSeaOfferCriteria;
}

interface OpenSeaOffersResponse {
  offers?: OpenSeaOffer[];
  next?: string;
}

interface OpenSeaNftDetail {
  identifier?: string;
  name?: string;
  image_url?: string;
  display_image_url?: string;
  traits?: Array<{ trait_type?: string; value?: string | number }>;
}

interface OpenSeaNftResponse {
  nft?: OpenSeaNftDetail;
}

interface NftDetails {
  imageUrl?: string;
  traits: Trait[];
}

interface OpenSeaSearchCollection {
  collection?: string; // slug
  name?: string;
  image_url?: string;
}

interface OpenSeaSearchResult {
  type?: string; // "collection" | "nft" | "token" | "account"
  collection?: OpenSeaSearchCollection;
}

interface OpenSeaSearchResponse {
  results?: OpenSeaSearchResult[];
}

interface OpenSeaCollectionsListResponse {
  collections?: Array<{ collection?: string; name?: string; image_url?: string }>;
  next?: string;
}

interface OpenSeaTraitsResponse {
  categories?: Record<string, string>;
  counts?: Record<string, Record<string, number>>;
}

interface OpenSeaSalePayment {
  quantity?: string; // base-unit string, e.g. wei
  token_address?: string;
  decimals?: number;
  symbol?: string;
}

interface OpenSeaSaleEvent {
  event_type: string;
  event_timestamp: number; // unix seconds
  transaction: string;
  payment?: OpenSeaSalePayment;
  seller: string;
  buyer: string;
  nft?: { identifier?: string; image_url?: string; display_image_url?: string };
}

interface OpenSeaEventsResponse {
  asset_events?: OpenSeaSaleEvent[];
  next?: string;
}

export const openseaClient = new OpenSeaClient();
