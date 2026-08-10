import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedCollection } from "../opensea/client.js";
import type { CollectionInfo, CollectionOfferInfo, ListingInfo } from "../types/index.js";
import type { AllowlistEntry } from "../watchlist/schema.js";
import {
  routeCommand,
  type AddWatchlistOutcome,
  type CommandInvocation,
  type CommandRouterDeps,
  type CreateLeadRuleOutcome,
  type RemoveWatchlistOutcome,
} from "./commandRouter.js";
import type { StatusInfo } from "./embeds.js";

const AUTHORIZED_USER_ID = "user-authorized";

function makeResolved(overrides: Partial<ResolvedCollection> = {}): ResolvedCollection {
  return { address: "0xabc0000000000000000000000000000000abc0", slug: "test-collection", name: "Test Collection", ...overrides };
}

function makeFloor(overrides: Partial<CollectionInfo> = {}): CollectionInfo {
  return {
    id: "0xabc",
    name: "Test Collection",
    floorPriceNative: 0.5,
    floorPriceCurrency: "ETH",
    chain: "ethereum",
    ...overrides,
  };
}

function makeListing(overrides: Partial<ListingInfo> = {}): ListingInfo {
  return {
    id: "listing-1",
    collectionId: "0xabc",
    tokenId: "1",
    priceNative: 0.3,
    priceCurrency: "ETH",
    seller: "0xseller00000000000000000000000000000000",
    source: "opensea",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeInvocation(overrides: Partial<CommandInvocation> = {}): CommandInvocation {
  return { commandName: "help", userId: AUTHORIZED_USER_ID, username: "Owner", ...overrides };
}

function makeWatchlistEntry(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    id: "super-punk-world-watch",
    label: "Super Punk World — Nina Chanel Abney",
    enabled: true,
    priorityTier: "watch",
    collection: "0x0000000000003f07248ddfb9821770a8200ef77d",
    filters: {},
    muted: false,
    dedupeWindowMinutes: 30,
    rateLimitPerHour: 8,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CommandRouterDeps> = {}): { deps: CommandRouterDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { addWatchlistEntry: [], removeWatchlistEntry: [], resolveCollection: [] };

  const deps: CommandRouterDeps = {
    authorizedUserId: AUTHORIZED_USER_ID,
    resolveCollection: async (input) => {
      calls.resolveCollection!.push(input);
      return makeResolved();
    },
    getFloor: async () => makeFloor(),
    getListings: async () => [],
    getOffers: async () => [],
    getCollectionImage: async () => null,
    getEthUsdRate: async () => undefined,
    listWatchlistEntries: () => [],
    addWatchlistEntry: (resolved, floor) => {
      calls.addWatchlistEntry!.push({ resolved, floor });
      return { ok: true, message: "added" } satisfies AddWatchlistOutcome;
    },
    removeWatchlistEntry: (input, resolvedAddress) => {
      calls.removeWatchlistEntry!.push({ input, resolvedAddress });
      return { ok: true, message: "removed" } satisfies RemoveWatchlistOutcome;
    },
    createLeadRule: (resolved, params) => {
      (calls.createLeadRule ??= []).push({ resolved, params });
      return { ok: true, message: "created", entry: makeWatchlistEntry() } satisfies CreateLeadRuleOutcome;
    },
    getStatusInfo: (): StatusInfo => ({
      dryRun: true,
      hasOpenSeaKey: true,
      watchlistCount: 3,
      discordWebhookEnabled: false,
      nextTrendCheckAt: new Date(),
      pollIntervalSeconds: 3600,
      trendAlertTimes: "08:00,20:00",
      uptimeSeconds: 120,
      lastPollAt: new Date().toISOString(),
      lastTrendCheckAt: null,
      rateLimitHealth: { requestsInLastMinute: 0, budgetPerMinute: 50, queueLength: 0, recent429Count: 0 },
      activitySummary: [],
      watchedItemCount: 0,
      whaleCount: 0,
      lastRecapAt: null,
      nextRecapAt: new Date(),
      chartsEnabled: true,
      portfolioAddress: null,
      portfolioEnsName: null,
    }),

    // --- Group 3 defaults; individual tests override what they exercise ---
    listWatchedItems: () => [],
    removeWatchedItem: (collectionId, tokenId) => {
      (calls.removeWatchedItem ??= []).push({ collectionId, tokenId });
      return true;
    },
    addWhale: (address, label) => {
      (calls.addWhale ??= []).push({ address, label });
      return { ok: true, message: `Now tracking ${label ?? address}.` };
    },
    removeWhale: (address) => {
      (calls.removeWhale ??= []).push({ address });
      return { ok: true, message: `Stopped tracking ${address}.` };
    },
    listWhales: () => [],
    describeSettings: () => [{ key: "show_usd", value: "true", source: "env" }],
    setGlobalSetting: (key, value) => {
      (calls.setGlobalSetting ??= []).push({ key, value });
      return { ok: true, message: `Set ${key} to ${value}.` };
    },
    resetGlobalSetting: (key) => {
      (calls.resetGlobalSetting ??= []).push({ key });
      return { ok: true, message: `Reset ${key}.` };
    },
    setEntrySetting: (collectionMatcher, key, value) => {
      (calls.setEntrySetting ??= []).push({ collectionMatcher, key, value });
      return { ok: true, message: `Set ${key} to ${value}.` };
    },
    getPortfolio: async () => null,
    ...overrides,
  };

  return { deps, calls };
}

test("routeCommand: rejects unauthorized users for every command, ephemerally, with no side effects", async () => {
  const { deps, calls } = makeDeps();
  const reply = await routeCommand(deps, makeInvocation({ commandName: "watchlist", subcommand: "add", collection: "Azuki", userId: "someone-else" }));

  assert.equal(reply.ephemeral, true);
  assert.match(reply.content ?? "", /not authorized/i);
  assert.equal(calls.resolveCollection!.length, 0);
  assert.equal(calls.addWatchlistEntry!.length, 0);
});

test("/watchlist add: resolves the collection and fetches floor, but returns a PREVIEW rather than adding immediately", async () => {
  const { deps, calls } = makeDeps();
  const reply = await routeCommand(deps, makeInvocation({ commandName: "watchlist", subcommand: "add", collection: "Test Collection" }));

  assert.equal(reply.ephemeral, true);
  assert.ok(reply.embed, "expected a preview embed");
  assert.match(reply.embed!.title, /Test Collection/);
  assert.ok(reply.pendingAdd, "expected pendingAdd so the caller (client.ts) can attach Confirm/Cancel buttons");
  assert.equal(reply.pendingAdd!.resolved.name, "Test Collection");
  assert.equal(reply.pendingAdd!.floor?.floorPriceNative, 0.5);
  // Nothing is written until the button is clicked (see client.ts) — routeCommand itself never calls addWatchlistEntry for "add".
  assert.equal(calls.addWatchlistEntry!.length, 0);
});

test("/watchlist add: rejects when the collection can't be resolved, without a preview", async () => {
  const { deps, calls } = makeDeps({ resolveCollection: async () => null });
  const reply = await routeCommand(deps, makeInvocation({ commandName: "watchlist", subcommand: "add", collection: "not-a-real-collection" }));

  assert.equal(reply.ephemeral, true);
  assert.match(reply.content ?? "", /Could not resolve/);
  assert.equal(reply.pendingAdd, undefined);
  assert.equal(calls.addWatchlistEntry!.length, 0);
});

test("/watchlist add: still returns a preview even if the floor fetch fails (floor shown as unavailable)", async () => {
  const { deps } = makeDeps({
    getFloor: async () => {
      throw new Error("network error");
    },
  });
  const reply = await routeCommand(deps, makeInvocation({ commandName: "watchlist", subcommand: "add", collection: "Test Collection" }));

  assert.equal(reply.ephemeral, true);
  assert.ok(reply.pendingAdd);
  assert.equal(reply.pendingAdd!.floor, null);
  assert.ok(reply.embed!.fields.some((f) => f.name === "Floor" && f.value === "unavailable"));
});

test("/watchlist remove: passes both the raw input and the resolved address, even if resolution fails", async () => {
  const { deps, calls } = makeDeps({ resolveCollection: async () => null });
  const reply = await routeCommand(deps, makeInvocation({ commandName: "watchlist", subcommand: "remove", collection: "some-broken-placeholder" }));

  assert.equal(reply.ephemeral, true);
  assert.match(reply.content ?? "", /removed/);
  assert.equal(calls.removeWatchlistEntry!.length, 1);
  const call = calls.removeWatchlistEntry![0] as { input: string; resolvedAddress: string | null };
  assert.equal(call.input, "some-broken-placeholder");
  assert.equal(call.resolvedAddress, null);
});

test("/watchlist list: renders whatever listWatchlistEntries returns, no resolution needed", async () => {
  const entries: AllowlistEntry[] = [
    { id: "a", label: "A", enabled: true, priorityTier: "watch", collection: "0xa", filters: {}, muted: false, dedupeWindowMinutes: 1, rateLimitPerHour: 1 },
  ];
  const { deps, calls } = makeDeps({ listWatchlistEntries: () => entries });
  const reply = await routeCommand(deps, makeInvocation({ commandName: "watchlist", subcommand: "list" }));

  assert.equal(reply.ephemeral, true);
  assert.ok(reply.embed);
  assert.equal(calls.resolveCollection!.length, 0);
});

test("/watchlist create-rule: rejects when condition is missing, without resolving or calling createLeadRule", async () => {
  const { deps, calls } = makeDeps();
  const reply = await routeCommand(deps, makeInvocation({ commandName: "watchlist", subcommand: "create-rule", collection: "Test Collection" }));

  assert.match(reply.content ?? "", /Provide a `condition`/);
  assert.equal(calls.resolveCollection!.length, 0);
  assert.equal((calls.createLeadRule ?? []).length, 0);
});

test("/watchlist create-rule: resolves the collection and forwards condition/price to createLeadRule", async () => {
  const { deps, calls } = makeDeps();
  const reply = await routeCommand(
    deps,
    makeInvocation({ commandName: "watchlist", subcommand: "create-rule", collection: "Test Collection", condition: "price_below", price: 0.3 }),
  );

  assert.equal(reply.ephemeral, true);
  assert.match(reply.content ?? "", /Created lead rule/);
  assert.equal(calls.createLeadRule!.length, 1);
  const call = calls.createLeadRule![0] as { resolved: ResolvedCollection; params: { condition: string; price?: number } };
  assert.equal(call.resolved.address, makeResolved().address);
  assert.equal(call.params.condition, "price_below");
  assert.equal(call.params.price, 0.3);
});

test("/watchlist create-rule: combines trait_category + trait_value into a single trait param", async () => {
  const { deps, calls } = makeDeps();
  await routeCommand(
    deps,
    makeInvocation({
      commandName: "watchlist",
      subcommand: "create-rule",
      collection: "Test Collection",
      condition: "trait_listed",
      traitCategory: "Background",
      traitValue: "Blue",
    }),
  );

  const call = calls.createLeadRule![0] as { params: { trait?: { key: string; value: string } } };
  assert.deepEqual(call.params.trait, { key: "Background", value: "Blue" });
});

test("/watchlist create-rule: surfaces createLeadRule's rejection message (e.g. invalid params)", async () => {
  const { deps } = makeDeps({
    createLeadRule: () => ({ ok: false, message: "Condition `price_below` requires a positive `price` (in ETH)." }),
  });
  const reply = await routeCommand(
    deps,
    makeInvocation({ commandName: "watchlist", subcommand: "create-rule", collection: "Test Collection", condition: "price_below" }),
  );
  assert.match(reply.content ?? "", /requires a positive `price`/);
});

test("/listings: filters to only listings within the requested time window", async () => {
  const now = Date.now();
  const listings = [
    makeListing({ id: "recent", createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() }), // 2h ago
    makeListing({ id: "borderline", createdAt: new Date(now - 5.5 * 60 * 60 * 1000).toISOString() }), // 5.5h ago
    makeListing({ id: "old", createdAt: new Date(now - 30 * 60 * 60 * 1000).toISOString() }), // 30h ago
  ];
  const { deps } = makeDeps({ getListings: async () => listings });

  const reply = await routeCommand(deps, makeInvocation({ commandName: "listings", collection: "Test Collection", hours: 6 }));

  assert.equal(reply.ephemeral, true);
  assert.ok(reply.embed);
  // 2 of 3 listings fall within the 6h window (2h and 5.5h ago); the 30h-old one must be excluded.
  assert.equal(reply.embed!.fields.length, 2);
  assert.ok(reply.embed!.title.includes("6h"));
});

test("/listings: defaults to a 24h window when hours is omitted", async () => {
  const now = Date.now();
  const listings = [makeListing({ createdAt: new Date(now - 23 * 60 * 60 * 1000).toISOString() })];
  const { deps } = makeDeps({ getListings: async () => listings });

  const reply = await routeCommand(deps, makeInvocation({ commandName: "listings", collection: "Test Collection" }));
  assert.ok(reply.embed!.title.includes("24h"));
  assert.equal(reply.embed!.fields.length, 1);
});

test("/listings: rejects when the collection can't be resolved", async () => {
  const { deps } = makeDeps({ resolveCollection: async () => null });
  const reply = await routeCommand(deps, makeInvocation({ commandName: "listings", collection: "nope" }));
  assert.match(reply.content ?? "", /Could not resolve/);
});

test("/floor: returns an embed built from the resolved collection's floor", async () => {
  const { deps } = makeDeps({ getFloor: async () => makeFloor({ floorPriceNative: 1.23 }) });
  const reply = await routeCommand(deps, makeInvocation({ commandName: "floor", collection: "Test Collection" }));
  assert.equal(reply.ephemeral, true);
  assert.ok(reply.embed);
  assert.ok(reply.embed!.fields.some((f) => f.value.includes("1.23")));
});

test("/floor: resolves a friendly watchlist name OpenSea itself can't resolve, via the watchlist entry's stored address", async () => {
  const entry = makeWatchlistEntry();
  const { deps, calls } = makeDeps({
    listWatchlistEntries: () => [entry],
    resolveCollection: async (input) => {
      calls.resolveCollection!.push(input);
      // Simulate OpenSea only resolving the exact stored address, never the friendly free-text name.
      return input === entry.collection ? makeResolved({ address: entry.collection, name: "Super Punk World" }) : null;
    },
  });

  const reply = await routeCommand(deps, makeInvocation({ commandName: "floor", collection: "super punk world" }));

  assert.equal(reply.ephemeral, true);
  assert.ok(reply.embed, "expected the friendly name to resolve via the watchlist entry");
  // The watchlist match short-circuits straight to resolving its stored
  // address — no point spending a call on the free-text input we already
  // know OpenSea can't resolve.
  assert.deepEqual(calls.resolveCollection, [entry.collection]);
});

test("/floor: an unresolvable input gets a friendly error suggesting the closest watchlist entry", async () => {
  const entry = makeWatchlistEntry();
  const { deps } = makeDeps({
    listWatchlistEntries: () => [entry],
    resolveCollection: async () => null,
  });

  const reply = await routeCommand(deps, makeInvocation({ commandName: "floor", collection: "super punk wrld" }));

  assert.match(reply.content ?? "", /Could not resolve/);
  assert.match(reply.content ?? "", /Did you mean \*\*Super Punk World/);
  assert.match(reply.content ?? "", /\/watchlist list/);
});

test("/offers: returns an embed built from current offers", async () => {
  const offers: CollectionOfferInfo[] = [
    { id: "o1", collectionId: "0xabc", priceNative: 0.4, priceCurrency: "ETH", bidder: "0xbidder0000000000000000000000000000000", source: "opensea", createdAt: new Date().toISOString(), scope: "collection" },
  ];
  const { deps } = makeDeps({ getOffers: async () => offers });
  const reply = await routeCommand(deps, makeInvocation({ commandName: "offers", collection: "Test Collection" }));
  assert.equal(reply.ephemeral, true);
  assert.equal(reply.embed!.fields.length, 1);
});

test("/status: reports the injected status info, ephemerally", async () => {
  const { deps } = makeDeps();
  const reply = await routeCommand(deps, makeInvocation({ commandName: "status" }));
  assert.equal(reply.ephemeral, true);
  assert.ok(reply.embed!.fields.some((f) => f.value === "DRY-RUN"));
});

test("/help: returns the static help embed, ephemerally", async () => {
  const { deps } = makeDeps();
  const reply = await routeCommand(deps, makeInvocation({ commandName: "help" }));
  assert.equal(reply.ephemeral, true);
  assert.ok(reply.embed!.fields.length > 0);
});

test("routeCommand: a thrown error from a dep is caught and reported ephemerally, not propagated", async () => {
  const { deps } = makeDeps({
    getFloor: async () => {
      throw new Error("boom");
    },
  });
  const reply = await routeCommand(deps, makeInvocation({ commandName: "floor", collection: "Test Collection" }));
  assert.equal(reply.ephemeral, true);
  assert.match(reply.content ?? "", /went wrong/);
});
