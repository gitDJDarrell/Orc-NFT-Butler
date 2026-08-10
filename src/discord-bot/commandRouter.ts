import type { ResolvedCollection } from "../opensea/client.js";
import type { CollectionInfo, CollectionOfferInfo, ListingInfo } from "../types/index.js";
import type { LeadRuleCondition, LeadRuleParams } from "../watchlist/mutate.js";
import { findWatchlistNameMatch, suggestClosestWatchlistEntry } from "../watchlist/resolveInput.js";
import type { AllowlistEntry } from "../watchlist/schema.js";
import {
  buildAddPreviewEmbed,
  buildFloorEmbed,
  buildHelpEmbed,
  buildListingsEmbed,
  buildOffersEmbed,
  buildStatusEmbed,
  buildWatchlistEmbed,
  type EmbedContent,
  type StatusInfo,
} from "./embeds.js";

export type CommandName = "watchlist" | "listings" | "floor" | "offers" | "status" | "help";
export type WatchlistSubcommand = "add" | "remove" | "list" | "create-rule";

export interface CommandInvocation {
  commandName: CommandName;
  subcommand?: WatchlistSubcommand;
  collection?: string;
  hours?: number;
  /** create-rule only, below */
  condition?: LeadRuleCondition;
  price?: number;
  percentile?: number;
  traitCategory?: string;
  traitValue?: string;
  userId: string;
  username: string;
}

/** A /watchlist add awaiting Confirm/Cancel — client.ts attaches the actual Discord buttons and stores this in PendingAddStore; commandRouter.ts stays discord.js-free. */
export interface PendingAddPreview {
  resolved: ResolvedCollection;
  floor: CollectionInfo | null;
}

export interface CommandReply {
  content?: string;
  embed?: EmbedContent;
  ephemeral: boolean;
  pendingAdd?: PendingAddPreview;
}

export interface AddWatchlistOutcome {
  ok: boolean;
  message: string;
  entry?: AllowlistEntry;
}

export interface RemoveWatchlistOutcome {
  ok: boolean;
  message: string;
  removed?: AllowlistEntry;
}

export interface CreateLeadRuleOutcome {
  ok: boolean;
  message: string;
  entry?: AllowlistEntry;
}

/**
 * Everything a command handler needs, abstracted away from discord.js —
 * same pattern as reactionRouter.ts. `addWatchlistEntry`/`removeWatchlistEntry`
 * are responsible for the full side-effecting flow (mutate watchlist.json,
 * save it, reload the live BidLeadMonitor) and just report the outcome back;
 * the real implementations live in src/discord-bot/client.ts.
 */
export interface CommandRouterDeps {
  authorizedUserId: string;
  resolveCollection: (input: string) => Promise<ResolvedCollection | null>;
  getFloor: (address: string) => Promise<CollectionInfo>;
  getListings: (address: string, limit: number) => Promise<ListingInfo[]>;
  getOffers: (address: string, limit: number) => Promise<CollectionOfferInfo[]>;
  /** Best-effort collection image for the /offers embed thumbnail; resolve failures are swallowed by the implementation (see client.ts). */
  getCollectionImage: (address: string) => Promise<{ imageUrl?: string; bannerImageUrl?: string } | null>;
  /** Live ETH/USD rate for "(~$X)" price suffixes — undefined shows ETH only (see OpenSeaClient.getEthUsdRate). */
  getEthUsdRate: () => Promise<number | undefined>;
  listWatchlistEntries: () => AllowlistEntry[];
  addWatchlistEntry: (resolved: ResolvedCollection, floor: CollectionInfo | null) => AddWatchlistOutcome;
  removeWatchlistEntry: (input: string, resolvedAddress: string | null) => RemoveWatchlistOutcome;
  createLeadRule: (resolved: ResolvedCollection, params: LeadRuleParams) => CreateLeadRuleOutcome;
  getStatusInfo: () => StatusInfo;
}

const DEFAULT_LISTINGS_HOURS = 24;
const LISTINGS_FETCH_LIMIT = 50;

/**
 * Routes one slash-command invocation. ONLY the configured authorized
 * user's commands are ever actioned — everyone else gets a private
 * rejection and nothing runs. This is the sole entry point for every
 * slash command this bot exposes.
 */
export async function routeCommand(deps: CommandRouterDeps, invocation: CommandInvocation): Promise<CommandReply> {
  if (!deps.authorizedUserId || invocation.userId !== deps.authorizedUserId) {
    return { content: "⛔ You're not authorized to use this bot.", ephemeral: true };
  }

  try {
    switch (invocation.commandName) {
      case "watchlist":
        return await handleWatchlist(deps, invocation);
      case "listings":
        return await handleListings(deps, invocation);
      case "floor":
        return await handleFloor(deps, invocation);
      case "offers":
        return await handleOffers(deps, invocation);
      case "status":
        return { embed: buildStatusEmbed(deps.getStatusInfo()), ephemeral: true };
      case "help":
        return { embed: buildHelpEmbed(), ephemeral: true };
      default:
        return { content: "Unknown command.", ephemeral: true };
    }
  } catch (err) {
    return { content: `Something went wrong: ${(err as Error).message}`, ephemeral: true };
  }
}

/**
 * Resolves a slash command's free-text `collection` input, in order:
 *   1. An ENABLED watchlist entry matched by normalized label (so a
 *      friendly name like "super punk world" resolves via its watchlist
 *      entry — see resolveInput.ts) — its stored address is then resolved
 *      the normal way to get the canonical name/slug.
 *   2. `deps.resolveCollection` directly — handles a 0x address, an exact
 *      OpenSea slug, or a name that happens to naively slugify to the real
 *      one (see opensea/client.ts).
 * OpenSea's API has no working free-text collection search (verified live
 * — `query`/`name` params on GET /collections are silently ignored), so
 * anything beyond those two paths can't be resolved; the error message
 * offers the closest watchlist match (if any) as a "did you mean".
 */
async function resolveCollectionForCommand(
  deps: CommandRouterDeps,
  input: string,
): Promise<{ resolved: ResolvedCollection } | { resolved: null; errorMessage: string }> {
  const entries = deps.listWatchlistEntries();

  const watchlistMatch = findWatchlistNameMatch(input, entries);
  if (watchlistMatch) {
    const resolved = await deps.resolveCollection(watchlistMatch.collection);
    if (resolved) return { resolved };
  }

  const resolved = await deps.resolveCollection(input);
  if (resolved) return { resolved };

  const suggestion = suggestClosestWatchlistEntry(input, entries);
  const suggestionText = suggestion ? ` Did you mean **${suggestion.label}**?` : "";
  return {
    resolved: null,
    errorMessage:
      `Could not resolve "${input}" to a real OpenSea collection or a watchlist entry.${suggestionText} ` +
      "Run `/watchlist list` to see what's tracked, or try the exact OpenSea slug or a 0x contract address.",
  };
}

async function handleWatchlist(deps: CommandRouterDeps, invocation: CommandInvocation): Promise<CommandReply> {
  if (invocation.subcommand === "list") {
    return { embed: buildWatchlistEmbed(deps.listWatchlistEntries()), ephemeral: true };
  }

  const input = invocation.collection?.trim();
  if (!input) {
    return { content: "Provide a `collection` (name, OpenSea slug, or 0x contract address).", ephemeral: true };
  }

  if (invocation.subcommand === "add") {
    const resolution = await resolveCollectionForCommand(deps, input);
    if (!resolution.resolved) {
      return { content: resolution.errorMessage, ephemeral: true };
    }
    const resolved = resolution.resolved;

    let floor: CollectionInfo | null = null;
    try {
      floor = await deps.getFloor(resolved.address);
    } catch {
      floor = null; // still allow previewing/adding without a floor reading — defaults just fall back to placeholders
    }

    const [collectionImage, ethUsdRate] = await Promise.all([
      deps.getCollectionImage(resolved.address).catch(() => null),
      deps.getEthUsdRate(),
    ]);
    // Nothing is written to watchlist.json yet — client.ts attaches
    // Confirm/Cancel buttons and only calls addWatchlistEntry() once the
    // authorized user clicks Confirm (see PendingAddStore).
    return {
      embed: buildAddPreviewEmbed(resolved, floor, collectionImage?.imageUrl, ethUsdRate),
      ephemeral: true,
      pendingAdd: { resolved, floor },
    };
  }

  if (invocation.subcommand === "remove") {
    const resolved = await deps.resolveCollection(input).catch(() => null);
    const outcome = deps.removeWatchlistEntry(input, resolved?.address ?? null);
    return { content: outcome.message, ephemeral: true };
  }

  if (invocation.subcommand === "create-rule") {
    return await handleCreateRule(deps, invocation, input);
  }

  return { content: "Unknown /watchlist subcommand.", ephemeral: true };
}

async function handleCreateRule(deps: CommandRouterDeps, invocation: CommandInvocation, input: string): Promise<CommandReply> {
  if (!invocation.condition) {
    return { content: "Provide a `condition` (price_below, rarity_top_percent, trait_listed, or trait_floor).", ephemeral: true };
  }

  const resolution = await resolveCollectionForCommand(deps, input);
  if (!resolution.resolved) {
    return { content: resolution.errorMessage, ephemeral: true };
  }

  const trait = invocation.traitCategory && invocation.traitValue ? { key: invocation.traitCategory, value: invocation.traitValue } : undefined;
  const params: LeadRuleParams = {
    condition: invocation.condition,
    price: invocation.price,
    percentile: invocation.percentile,
    trait,
  };

  const outcome = deps.createLeadRule(resolution.resolved, params);
  if (!outcome.ok) {
    return { content: outcome.message, ephemeral: true };
  }

  return { content: `✅ Created lead rule: **${outcome.entry!.label}**`, ephemeral: true };
}

async function handleListings(deps: CommandRouterDeps, invocation: CommandInvocation): Promise<CommandReply> {
  const input = invocation.collection?.trim();
  if (!input) return { content: "Provide a `collection`.", ephemeral: true };

  const resolution = await resolveCollectionForCommand(deps, input);
  if (!resolution.resolved) {
    return { content: resolution.errorMessage, ephemeral: true };
  }
  const resolved = resolution.resolved;

  const hours = invocation.hours && invocation.hours > 0 ? invocation.hours : DEFAULT_LISTINGS_HOURS;
  const cutoffMs = Date.now() - hours * 60 * 60 * 1000;

  const [listings, ethUsdRate] = await Promise.all([deps.getListings(resolved.address, LISTINGS_FETCH_LIMIT), deps.getEthUsdRate()]);
  const withinWindow = listings.filter((l) => new Date(l.createdAt).getTime() >= cutoffMs);

  return { embed: buildListingsEmbed(resolved.name, hours, withinWindow, ethUsdRate), ephemeral: true };
}

async function handleFloor(deps: CommandRouterDeps, invocation: CommandInvocation): Promise<CommandReply> {
  const input = invocation.collection?.trim();
  if (!input) return { content: "Provide a `collection`.", ephemeral: true };

  const resolution = await resolveCollectionForCommand(deps, input);
  if (!resolution.resolved) {
    return { content: resolution.errorMessage, ephemeral: true };
  }
  const resolved = resolution.resolved;

  const [floor, ethUsdRate] = await Promise.all([deps.getFloor(resolved.address), deps.getEthUsdRate()]);
  return { embed: buildFloorEmbed(resolved.address, floor, ethUsdRate), ephemeral: true };
}

async function handleOffers(deps: CommandRouterDeps, invocation: CommandInvocation): Promise<CommandReply> {
  const input = invocation.collection?.trim();
  if (!input) return { content: "Provide a `collection`.", ephemeral: true };

  const resolution = await resolveCollectionForCommand(deps, input);
  if (!resolution.resolved) {
    return { content: resolution.errorMessage, ephemeral: true };
  }
  const resolved = resolution.resolved;

  const [offers, collectionImage, ethUsdRate] = await Promise.all([
    deps.getOffers(resolved.address, 20),
    deps.getCollectionImage(resolved.address).catch(() => null),
    deps.getEthUsdRate(),
  ]);
  return { embed: buildOffersEmbed(resolved.name, offers, collectionImage?.imageUrl, ethUsdRate), ephemeral: true };
}
