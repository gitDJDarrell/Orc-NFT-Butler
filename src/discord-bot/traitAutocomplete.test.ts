import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedCollection } from "../opensea/client.js";
import type { TraitCategory } from "../types/index.js";
import {
  HINT_LOADING,
  HINT_PICK_CATEGORY,
  HINT_PICK_COLLECTION,
  HINT_UNAVAILABLE,
  HINT_VALUE,
  TraitAutocomplete,
  isHintValue,
  type TraitAutocompleteDeps,
} from "./traitAutocomplete.js";

const CATALOG: TraitCategory[] = [
  { key: "Background", values: ["Blue", "Red", "Green", "Blue Steel"] },
  { key: "Headwear", values: ["Crown", "Cap", "Bandana"] },
  { key: "Eyes", values: ["Laser", "Sleepy"] },
];

const RESOLVED: ResolvedCollection = { address: "0xabc", slug: "test-collection", name: "Test Collection" };

interface Harness {
  ac: TraitAutocomplete;
  calls: { resolve: string[]; traits: string[] };
  clock: { t: number };
}

function makeHarness(overrides: Partial<TraitAutocompleteDeps> = {}): Harness {
  const calls = { resolve: [] as string[], traits: [] as string[] };
  const clock = { t: 1_000_000 };

  const deps: TraitAutocompleteDeps = {
    resolveCollection: async (input) => {
      calls.resolve.push(input);
      return RESOLVED;
    },
    getCollectionTraits: async (id) => {
      calls.traits.push(id);
      return CATALOG;
    },
    now: () => clock.t,
    ...overrides,
  };

  return { ac: new TraitAutocomplete(deps), calls, clock };
}

/** The catalog loads in the background; let the microtask queue drain. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function names(choices: { name: string }[]): string[] {
  return choices.map((c) => c.name);
}

// --- The bug: no dropdown at all ---------------------------------------

test("never returns an empty list — an empty response is what Discord renders as no dropdown", async () => {
  const { ac } = makeHarness();

  // Every failure/edge path must still produce at least one row.
  assert.ok(ac.buildCategoryChoices(null, "").length > 0, "no collection");
  assert.ok(ac.buildCategoryChoices("Test Collection", "").length > 0, "cold cache");
  await settle();
  assert.ok(ac.buildCategoryChoices("Test Collection", "zzzznomatch").length > 0, "no match");
  assert.ok(ac.buildValueChoices("Test Collection", null, "").length > 0, "no category");
  assert.ok(ac.buildValueChoices("Test Collection", "Nope", "").length > 0, "unknown category");
});

test("no collection selected yields the pick-a-collection hint", () => {
  const { ac, calls } = makeHarness();
  const choices = ac.buildCategoryChoices(null, "back");

  assert.deepEqual(names(choices), [HINT_PICK_COLLECTION]);
  assert.equal(choices[0]!.value, HINT_VALUE);
  assert.equal(calls.resolve.length, 0, "must not hit the network with no collection");
});

test("blank / hint-valued collection is treated as not selected", () => {
  const { ac } = makeHarness();
  assert.deepEqual(names(ac.buildCategoryChoices("   ", "")), [HINT_PICK_COLLECTION]);
  assert.deepEqual(names(ac.buildCategoryChoices(HINT_VALUE, "")), [HINT_PICK_COLLECTION]);
});

// --- Cache-then-filter behavior ----------------------------------------

test("first keystroke returns the loading hint and does NOT block on the network", () => {
  const { ac } = makeHarness();
  const choices = ac.buildCategoryChoices("Test Collection", "");

  // Synchronous return is the point: no await, so it can't lose Discord's ~3s race.
  assert.deepEqual(names(choices), [HINT_LOADING]);
});

test("after the background load, categories are filtered from cache", async () => {
  const { ac } = makeHarness();
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  assert.deepEqual(names(ac.buildCategoryChoices("Test Collection", "")), ["Background", "Headwear", "Eyes"]);
  assert.deepEqual(names(ac.buildCategoryChoices("Test Collection", "ea")), ["Headwear"]);
  assert.deepEqual(names(ac.buildCategoryChoices("Test Collection", "e")), ["Headwear", "Eyes"]);
});

test("category filtering is case-insensitive", async () => {
  const { ac } = makeHarness();
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  assert.deepEqual(names(ac.buildCategoryChoices("Test Collection", "BACK")), ["Background"]);
});

test("the catalog is fetched ONCE across many keystrokes", async () => {
  const { ac, calls } = makeHarness();
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  for (const q of ["B", "Ba", "Bac", "Back", "Backg"]) ac.buildCategoryChoices("Test Collection", q);
  ac.buildValueChoices("Test Collection", "Background", "Bl");
  await settle();

  assert.equal(calls.traits.length, 1, `expected exactly one trait fetch, got ${calls.traits.length}`);
  assert.equal(calls.resolve.length, 1, `expected exactly one resolve, got ${calls.resolve.length}`);
});

test("concurrent cold keystrokes are deduped into a single load", async () => {
  const { ac, calls } = makeHarness();
  ac.buildCategoryChoices("Test Collection", "a");
  ac.buildCategoryChoices("Test Collection", "ab");
  ac.buildCategoryChoices("Test Collection", "abc");
  await settle();

  assert.equal(calls.traits.length, 1);
});

// --- Resolution (the primary root cause) -------------------------------

test("resolves typed free text through the resolver rather than using it as a slug", async () => {
  // The old code passed the raw field straight to /traits/{slug}, so typed
  // text like "Super Punk World" became a 404 and an empty dropdown.
  const { ac, calls } = makeHarness();
  ac.buildCategoryChoices("Super Punk World", "");
  await settle();

  assert.deepEqual(calls.resolve, ["Super Punk World"]);
  assert.deepEqual(calls.traits, [RESOLVED.address], "traits must be fetched by the RESOLVED address, not the typed text");
});

test("a watchlist display name resolves via the watchlist without an API resolve", async () => {
  const { ac, calls } = makeHarness({
    findWatchlistCollection: (input) => (input.toLowerCase().includes("punk") ? "0xwatchlisted" : null),
  });
  ac.buildCategoryChoices("Super Punk World", "");
  await settle();

  assert.equal(calls.resolve.length, 0, "watchlist match should short-circuit the resolver");
  assert.deepEqual(calls.traits, ["0xwatchlisted"]);
});

test("unresolvable collection yields the unavailable hint, not an empty list", async () => {
  const { ac } = makeHarness({ resolveCollection: async () => null });
  ac.buildCategoryChoices("Not A Real Collection", "");
  await settle();

  assert.deepEqual(names(ac.buildCategoryChoices("Not A Real Collection", "")), [HINT_UNAVAILABLE]);
});

// --- Failure paths ------------------------------------------------------

test("a throwing trait fetch yields the unavailable hint", async () => {
  const { ac } = makeHarness({
    getCollectionTraits: async () => {
      throw new Error("429 rate limited");
    },
  });
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  assert.deepEqual(names(ac.buildCategoryChoices("Test Collection", "")), [HINT_UNAVAILABLE]);
});

test("an empty catalog yields the unavailable hint", async () => {
  const { ac } = makeHarness({ getCollectionTraits: async () => [] });
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  assert.deepEqual(names(ac.buildCategoryChoices("Test Collection", "")), [HINT_UNAVAILABLE]);
});

test("a failure is retried after its short TTL, not cached for the full catalog TTL", async () => {
  let shouldFail = true;
  const { ac, clock, calls } = makeHarness({
    getCollectionTraits: async () => {
      calls.traits.push("x");
      if (shouldFail) throw new Error("transient 429");
      return CATALOG;
    },
  });

  ac.buildCategoryChoices("Test Collection", "");
  await settle();
  assert.deepEqual(names(ac.buildCategoryChoices("Test Collection", "")), [HINT_UNAVAILABLE]);

  // Inside the failure TTL: no retry.
  clock.t += 30_000;
  ac.buildCategoryChoices("Test Collection", "");
  await settle();
  assert.equal(calls.traits.length, 1, "must not hammer a failing endpoint");

  // Past the failure TTL: retried, and recovers.
  shouldFail = false;
  clock.t += 61_000;
  ac.buildCategoryChoices("Test Collection", "");
  await settle();
  assert.deepEqual(names(ac.buildCategoryChoices("Test Collection", "")), ["Background", "Headwear", "Eyes"]);
});

test("a stale catalog is still served while it refreshes in the background", async () => {
  const { ac, clock, calls } = makeHarness();
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  clock.t += 31 * 60_000; // past READY_TTL
  const choices = ac.buildCategoryChoices("Test Collection", "");
  assert.deepEqual(names(choices), ["Background", "Headwear", "Eyes"], "stale data beats a loading hint");
  await settle();
  assert.equal(calls.traits.length, 2, "a refresh should have been kicked off");
});

// --- trait_value scoping ------------------------------------------------

test("values are scoped to the chosen category", async () => {
  const { ac } = makeHarness();
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  assert.deepEqual(names(ac.buildValueChoices("Test Collection", "Headwear", "")), ["Crown", "Cap", "Bandana"]);
  assert.deepEqual(names(ac.buildValueChoices("Test Collection", "Eyes", "")), ["Laser", "Sleepy"]);
});

test("values filter by query within the category", async () => {
  const { ac } = makeHarness();
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  assert.deepEqual(names(ac.buildValueChoices("Test Collection", "Background", "blue")), ["Blue", "Blue Steel"]);
  assert.deepEqual(names(ac.buildValueChoices("Test Collection", "Background", "steel")), ["Blue Steel"]);
});

test("category matching is case-insensitive so a hand-typed category still works", async () => {
  const { ac } = makeHarness();
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  assert.deepEqual(names(ac.buildValueChoices("Test Collection", "background", "red")), ["Red"]);
});

test("missing or hint-valued category yields the pick-a-category hint", async () => {
  const { ac } = makeHarness();
  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  assert.deepEqual(names(ac.buildValueChoices("Test Collection", null, "")), [HINT_PICK_CATEGORY]);
  assert.deepEqual(names(ac.buildValueChoices("Test Collection", HINT_VALUE, "")), [HINT_PICK_CATEGORY]);
  assert.deepEqual(names(ac.buildValueChoices("Test Collection", "Nonexistent", "")), [HINT_PICK_CATEGORY]);
});

// --- Discord limits -----------------------------------------------------

test("clamps to 25 choices and 100 characters", async () => {
  const big: TraitCategory[] = [{ key: "Many", values: Array.from({ length: 60 }, (_, i) => `value-${i}`) }];
  const longName = "L".repeat(150);
  const { ac } = makeHarness({ getCollectionTraits: async () => [...big, { key: longName, values: [longName] }] });

  ac.buildCategoryChoices("Test Collection", "");
  await settle();

  const values = ac.buildValueChoices("Test Collection", "Many", "value");
  assert.equal(values.length, 25, "must not exceed Discord's 25-choice cap");

  const cats = ac.buildCategoryChoices("Test Collection", "LLL");
  assert.equal(cats[0]!.name.length, 100);
  assert.equal(cats[0]!.value.length, 100);
});

// --- prefetch + helpers -------------------------------------------------

test("prefetch warms the cache so the first trait keystroke is already populated", async () => {
  const { ac, calls } = makeHarness();
  ac.prefetch("Test Collection");
  await settle();

  assert.equal(calls.traits.length, 1);
  assert.deepEqual(names(ac.buildCategoryChoices("Test Collection", "")), ["Background", "Headwear", "Eyes"]);
});

test("prefetch is a no-op for blank/hint input and doesn't re-fetch a warm cache", async () => {
  const { ac, calls } = makeHarness();
  ac.prefetch(null);
  ac.prefetch("  ");
  ac.prefetch(HINT_VALUE);
  await settle();
  assert.equal(calls.traits.length, 0);

  ac.prefetch("Test Collection");
  await settle();
  ac.prefetch("Test Collection");
  await settle();
  assert.equal(calls.traits.length, 1, "a warm cache must not be re-fetched");
});

test("isHintValue identifies hint rows so create-rule can reject them", () => {
  assert.equal(isHintValue(HINT_VALUE), true);
  assert.equal(isHintValue("Background"), false);
  assert.equal(isHintValue(undefined), false);
  assert.equal(isHintValue(null), false);
});

test("every hint row carries the sentinel value", async () => {
  const { ac } = makeHarness({ resolveCollection: async () => null });
  assert.equal(ac.buildCategoryChoices(null, "")[0]!.value, HINT_VALUE);
  assert.equal(ac.buildCategoryChoices("x", "")[0]!.value, HINT_VALUE);
  await settle();
  assert.equal(ac.buildCategoryChoices("x", "")[0]!.value, HINT_VALUE);
  assert.equal(ac.buildValueChoices("x", null, "")[0]!.value, HINT_VALUE);
});
