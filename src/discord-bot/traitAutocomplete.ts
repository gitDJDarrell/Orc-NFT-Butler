import type { ResolvedCollection } from "../opensea/client.js";
import type { TraitCategory } from "../types/index.js";

/**
 * Trait autocomplete for /watchlist create-rule.
 *
 * WHY THIS EXISTS (the bug it fixes): trait suggestions silently never
 * appeared, while collection suggestions worked fine. Three compounding
 * causes, all of which ended in `respond([])` — which Discord renders as no
 * dropdown at all, with no error, so every failure looked identical:
 *
 *   1. The handler read `collection` straight off the interaction and passed
 *      it to the traits endpoint. During autocomplete that field holds
 *      whatever the user has TYPED so far — usually free text like
 *      "Super Punk World", not a slug they picked from the dropdown. That
 *      became `GET /traits/Super Punk World`, a 404, and an empty list.
 *      Collection autocomplete never hit this because it *searches* from raw
 *      text rather than needing an already-resolved collection.
 *   2. It made a LIVE trait fetch on every keystroke, raced against a ~1.8s
 *      guard inside Discord's ~3s window. That call shares the same
 *      rate-limited scheduler as polling, so under load (or a 429 on the
 *      free-tier key) it routinely lost the race and fell back to [].
 *   3. Every failure path returned [], so "no collection yet", "still
 *      loading", and "collection has no traits" were indistinguishable.
 *
 * THE FIX: never block autocomplete on the network. The trait catalog is
 * fetched ONCE per collection into a TTL cache; keystrokes only filter that
 * cached list in memory. A cache miss starts a background load and returns a
 * short hint immediately, so the response is always fast and always
 * non-empty. Stale entries are served while refreshing behind the scenes.
 */

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export interface TraitAutocompleteDeps {
  /** Same resolver the commands use — turns an address, slug, or display name into a canonical collection. */
  resolveCollection: (input: string) => Promise<ResolvedCollection | null>;
  /** Full trait catalog for a collection (address or slug). */
  getCollectionTraits: (collectionIdOrSlug: string) => Promise<TraitCategory[]>;
  /** Maps a typed display name to a watchlist entry's stored address, so friendly names resolve too. Returns null when nothing matches. */
  findWatchlistCollection?: (input: string) => string | null;
  /** Injectable clock for TTL tests. */
  now?: () => number;
}

/** Shown when the user hasn't chosen a collection yet — traits are collection-scoped, so there's nothing to suggest. */
export const HINT_PICK_COLLECTION = "⤴ Pick a collection first, then traits will load";
/** Shown on a cache miss while the catalog loads in the background. */
export const HINT_LOADING = "⏳ Loading traits… keep typing to see them";
/** Shown when the collection couldn't be resolved or has no readable trait catalog. */
export const HINT_UNAVAILABLE = "⚠ Traits unavailable for this collection";
/** Shown when a category is typed/selected that isn't in the catalog. */
export const HINT_PICK_CATEGORY = "⤴ Pick a trait category first";

/**
 * Sentinel used as a hint choice's `value`. Discord requires a non-empty
 * value, and selecting a hint must not look like a real trait — this fails
 * validateLeadRuleParams loudly rather than silently creating a rule for a
 * trait named "Loading traits...".
 */
export const HINT_VALUE = "__no_selection__";

const MAX_CHOICES = 25;
const MAX_FIELD_LEN = 100;

/** Catalogs are static once a collection is revealed, so this can be generous. */
const READY_TTL_MS = 30 * 60_000;
/** Failures expire fast so a transient 429/timeout recovers on the next keystroke rather than being cached for half an hour. */
const FAILED_TTL_MS = 60_000;

type CacheEntry =
  | { status: "loading"; at: number }
  | { status: "ready"; at: number; categories: TraitCategory[] }
  | { status: "failed"; at: number };

function hint(text: string): AutocompleteChoice[] {
  return [{ name: clamp(text), value: HINT_VALUE }];
}

function clamp(value: string): string {
  return value.length > MAX_FIELD_LEN ? value.slice(0, MAX_FIELD_LEN) : value;
}

/** True for any of the hint sentinels — used to treat a hint-selected category as "not chosen". */
export function isHintValue(value: string | undefined | null): boolean {
  return value === HINT_VALUE;
}

export class TraitAutocomplete {
  private readonly deps: TraitAutocompleteDeps;
  private readonly cache = new Map<string, CacheEntry>();
  /** Dedupes concurrent loads for the same collection — keystrokes arrive far faster than the fetch completes. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: TraitAutocompleteDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private static key(collectionInput: string): string {
    return collectionInput.trim().toLowerCase();
  }

  /** Test seam / operational escape hatch. */
  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /**
   * Returns the cached catalog if usable, otherwise kicks off a background
   * load and returns null so the caller can show a hint. NEVER awaits the
   * network — that's the whole point.
   */
  private catalogOrBackgroundLoad(collectionInput: string): { categories: TraitCategory[] } | { pending: "loading" | "failed" } {
    const key = TraitAutocomplete.key(collectionInput);
    const entry = this.cache.get(key);
    const age = entry ? this.now() - entry.at : Infinity;

    if (entry?.status === "ready") {
      if (age < READY_TTL_MS) return { categories: entry.categories };
      // Stale-while-revalidate: hand back what we have, refresh behind it.
      void this.startLoad(key, collectionInput);
      return { categories: entry.categories };
    }

    if (entry?.status === "failed" && age < FAILED_TTL_MS) {
      return { pending: "failed" };
    }

    if (entry?.status === "loading" && age < READY_TTL_MS) {
      return { pending: "loading" };
    }

    void this.startLoad(key, collectionInput);
    return { pending: "loading" };
  }

  private startLoad(key: string, collectionInput: string): Promise<void> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    this.cache.set(key, { status: "loading", at: this.now() });

    const task = (async () => {
      try {
        // Resolve the same way the commands do: a watchlist display name
        // first, then the address/slug resolver. This is what the old code
        // skipped, and why typed free text produced a 404.
        const viaWatchlist = this.deps.findWatchlistCollection?.(collectionInput) ?? null;
        const resolved = viaWatchlist ?? (await this.deps.resolveCollection(collectionInput))?.address ?? null;

        if (!resolved) {
          console.warn(`[trait-autocomplete] Could not resolve collection "${collectionInput}" — no trait catalog to load.`);
          this.cache.set(key, { status: "failed", at: this.now() });
          return;
        }

        const categories = await this.deps.getCollectionTraits(resolved);
        if (!Array.isArray(categories) || categories.length === 0) {
          console.warn(`[trait-autocomplete] Collection "${collectionInput}" (${resolved}) returned no trait categories.`);
          this.cache.set(key, { status: "failed", at: this.now() });
          return;
        }

        console.log(`[trait-autocomplete] Cached ${categories.length} trait categor(ies) for "${collectionInput}" (${resolved}).`);
        this.cache.set(key, { status: "ready", at: this.now(), categories });
      } catch (err) {
        console.warn(`[trait-autocomplete] Failed to load traits for "${collectionInput}": ${(err as Error).message}`);
        this.cache.set(key, { status: "failed", at: this.now() });
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, task);
    return task;
  }

  /** Suggestions for `trait_category`, filtered locally against the cached catalog. */
  buildCategoryChoices(collectionInput: string | null | undefined, rawQuery: string): AutocompleteChoice[] {
    if (!collectionInput || !collectionInput.trim() || isHintValue(collectionInput)) {
      return hint(HINT_PICK_COLLECTION);
    }

    const catalog = this.catalogOrBackgroundLoad(collectionInput);
    if ("pending" in catalog) {
      return hint(catalog.pending === "failed" ? HINT_UNAVAILABLE : HINT_LOADING);
    }

    const query = rawQuery.trim().toLowerCase();
    const matches = catalog.categories.filter((c) => c.key.toLowerCase().includes(query));
    console.log(
      `[trait-autocomplete] category query="${rawQuery}" collection="${collectionInput}" -> ${matches.length} match(es) of ${catalog.categories.length} cached.`,
    );

    if (matches.length === 0) return hint(HINT_UNAVAILABLE);
    return matches.slice(0, MAX_CHOICES).map((c) => ({ name: clamp(c.key), value: clamp(c.key) }));
  }

  /** Suggestions for `trait_value`, scoped to the chosen category and filtered locally. */
  buildValueChoices(
    collectionInput: string | null | undefined,
    categoryInput: string | null | undefined,
    rawQuery: string,
  ): AutocompleteChoice[] {
    if (!collectionInput || !collectionInput.trim() || isHintValue(collectionInput)) {
      return hint(HINT_PICK_COLLECTION);
    }
    if (!categoryInput || !categoryInput.trim() || isHintValue(categoryInput)) {
      return hint(HINT_PICK_CATEGORY);
    }

    const catalog = this.catalogOrBackgroundLoad(collectionInput);
    if ("pending" in catalog) {
      return hint(catalog.pending === "failed" ? HINT_UNAVAILABLE : HINT_LOADING);
    }

    // Case-insensitive so a hand-typed category still matches the catalog.
    const wanted = categoryInput.trim().toLowerCase();
    const category = catalog.categories.find((c) => c.key.toLowerCase() === wanted);
    if (!category) {
      console.warn(`[trait-autocomplete] Category "${categoryInput}" not found in the cached catalog for "${collectionInput}".`);
      return hint(HINT_PICK_CATEGORY);
    }

    const query = rawQuery.trim().toLowerCase();
    const matches = category.values.filter((v) => v.toLowerCase().includes(query));
    console.log(
      `[trait-autocomplete] value query="${rawQuery}" collection="${collectionInput}" category="${categoryInput}" -> ${matches.length} match(es) of ${category.values.length}.`,
    );

    if (matches.length === 0) return hint(HINT_UNAVAILABLE);
    return matches.slice(0, MAX_CHOICES).map((v) => ({ name: clamp(v), value: clamp(v) }));
  }

  /**
   * Warms the cache for a collection the user just picked, so the trait
   * fields are usually populated by the time they tab into them. Safe to
   * call repeatedly — deduped and non-blocking.
   */
  prefetch(collectionInput: string | null | undefined): void {
    if (!collectionInput || !collectionInput.trim() || isHintValue(collectionInput)) return;
    const key = TraitAutocomplete.key(collectionInput);
    const entry = this.cache.get(key);
    if (entry && this.now() - entry.at < (entry.status === "failed" ? FAILED_TTL_MS : READY_TTL_MS)) return;
    void this.startLoad(key, collectionInput);
  }
}
