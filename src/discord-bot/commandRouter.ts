import type { ResolvedCollection } from "../opensea/client.js";
import type { PortfolioSnapshot } from "../portfolio/portfolio.js";
import type { CollectionInfo, CollectionOfferInfo, ListingInfo } from "../types/index.js";
import {
  ENTRY_SETTING_KEYS,
  GLOBAL_SETTING_KEYS,
  type EntrySettingKey,
  type GlobalSettingKey,
} from "../watchlist/configMutate.js";
import type { LeadRuleCondition, LeadRuleParams } from "../watchlist/mutate.js";
import { findWatchlistNameMatch, suggestClosestWatchlistEntry } from "../watchlist/resolveInput.js";
import type { AllowlistEntry } from "../watchlist/schema.js";
import type { WatchedItem } from "../watchlist/watchStore.js";
import type { WhaleWallet } from "../watchlist/whaleStore.js";
import { isHintValue } from "./traitAutocomplete.js";
import {
  buildAddPreviewEmbed,
  buildConfigEmbed,
  buildFloorEmbed,
  buildHelpEmbed,
  buildListingsEmbed,
  buildOffersEmbed,
  buildPortfolioEmbed,
  buildStatusEmbed,
  buildWatchingEmbed,
  buildWatchlistEmbed,
  buildWhaleListEmbed,
  type EmbedContent,
  type StatusInfo,
} from "./embeds.js";

export type CommandName = "watchlist" | "listings" | "floor" | "offers" | "status" | "help" | "watching" | "whale" | "config" | "portfolio";
export type WatchlistSubcommand = "add" | "remove" | "list" | "create-rule";
export type WatchingSubcommand = "list" | "remove";
export type WhaleSubcommand = "add" | "remove" | "list";
export type ConfigSubcommand = "show" | "set" | "reset" | "entry";

export interface CommandInvocation {
  commandName: CommandName;
  subcommand?: WatchlistSubcommand | WatchingSubcommand | WhaleSubcommand | ConfigSubcommand;
  collection?: string;
  hours?: number;
  /** create-rule only, below */
  condition?: LeadRuleCondition;
  price?: number;
  percentile?: number;
  traitCategory?: string;
  traitValue?: string;
  /** /watching remove */
  tokenId?: string;
  /** /whale add|remove */
  address?: string;
  label?: string;
  /** /config set|reset|entry */
  key?: string;
  value?: string;
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

  // --- Group 3 ---
  /** Every item currently marked 👀 (persisted — see WatchStore). */
  listWatchedItems: () => WatchedItem[];
  /** Returns false when the token wasn't being watched. */
  removeWatchedItem: (collectionId: string, tokenId: string) => boolean;
  addWhale: (address: string, label?: string) => { ok: boolean; message: string };
  removeWhale: (address: string) => { ok: boolean; message: string };
  listWhales: () => WhaleWallet[];
  /** Current global tunables + whether each comes from Discord or .env. */
  describeSettings: () => Array<{ key: string; value: string; source: "discord" | "env" }>;
  /** Applies a validated `/config` mutation: writes watchlist.json and reloads the live monitor. */
  setGlobalSetting: (key: GlobalSettingKey, value: string) => { ok: boolean; message: string };
  resetGlobalSetting: (key: GlobalSettingKey) => { ok: boolean; message: string };
  setEntrySetting: (collectionMatcher: string, key: EntrySettingKey, value: string) => { ok: boolean; message: string };
  /** READ-ONLY portfolio snapshot; null when no address could be resolved. */
  getPortfolio: () => Promise<PortfolioSnapshot | null>;
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
      case "watching":
        return await handleWatching(deps, invocation);
      case "whale":
        return handleWhale(deps, invocation);
      case "config":
        return await handleConfig(deps, invocation);
      case "portfolio":
        return await handlePortfolio(deps);
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

  // Trait autocomplete emits hint rows ("pick a collection first", "loading…")
  // so the dropdown is never silently empty. Those are not real traits —
  // reject them explicitly rather than writing a rule for a trait literally
  // named after the hint.
  if (isHintValue(invocation.traitCategory) || isHintValue(invocation.traitValue)) {
    return {
      content:
        "That trait selection was a placeholder from the dropdown, not a real trait. " +
        "Pick a `collection` first, wait a moment for its traits to load, then choose `trait_category` and `trait_value`.",
      ephemeral: true,
    };
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

// --- Group 3 handlers ---

/**
 * `/watching list|remove`. Removal resolves the collection the same way
 * every other command does, but falls back to matching the raw input
 * against what's actually being watched — so the exact `\`/watching remove
 * collection:0x… token_id:…\`` line printed in `/watching list` always
 * works, even if OpenSea can't resolve that address right now.
 */
async function handleWatching(deps: CommandRouterDeps, invocation: CommandInvocation): Promise<CommandReply> {
  const watched = deps.listWatchedItems();

  if (invocation.subcommand === "remove") {
    const collectionInput = invocation.collection?.trim();
    const tokenId = invocation.tokenId?.trim();
    if (!collectionInput || !tokenId) {
      return { content: "Provide both `collection` and `token_id`. Run `/watching list` to see what's being watched.", ephemeral: true };
    }

    const resolved = await deps.resolveCollection(collectionInput).catch(() => null);
    const candidateIds = [resolved?.address, collectionInput].filter((v): v is string => Boolean(v));
    const match = watched.find(
      (item) => item.tokenId === tokenId && candidateIds.some((id) => id.toLowerCase() === item.collectionId.toLowerCase()),
    );

    if (!match) {
      return {
        content: `Not watching **${collectionInput} #${tokenId}**. Run \`/watching list\` to see what is being watched.`,
        ephemeral: true,
      };
    }

    const removed = deps.removeWatchedItem(match.collectionId, match.tokenId);
    return {
      content: removed
        ? `🚫 Stopped watching **${match.collectionName} #${match.tokenId}**.`
        : `Could not stop watching **${match.collectionName} #${match.tokenId}** — it may have just been removed.`,
      ephemeral: true,
    };
  }

  const ethUsdRate = await deps.getEthUsdRate();
  return { embed: buildWatchingEmbed(watched, ethUsdRate), ephemeral: true };
}

/** `/whale add|remove|list`. Validation lives in WhaleStore so it's shared with any other caller. */
function handleWhale(deps: CommandRouterDeps, invocation: CommandInvocation): CommandReply {
  if (invocation.subcommand === "list") {
    return { embed: buildWhaleListEmbed(deps.listWhales()), ephemeral: true };
  }

  const address = invocation.address?.trim();
  if (!address) return { content: "Provide an `address` (0x…).", ephemeral: true };

  if (invocation.subcommand === "add") {
    const outcome = deps.addWhale(address, invocation.label?.trim() || undefined);
    return {
      content: outcome.ok
        ? `🐋 ${outcome.message}\nAlerts fire only for activity **inside allowlisted collections**.`
        : `⚠️ ${outcome.message}`,
      ephemeral: true,
    };
  }

  if (invocation.subcommand === "remove") {
    const outcome = deps.removeWhale(address);
    return { content: outcome.ok ? `🗑️ ${outcome.message}` : `⚠️ ${outcome.message}`, ephemeral: true };
  }

  return { content: "Unknown /whale subcommand.", ephemeral: true };
}

function isGlobalSettingKey(key: string): key is GlobalSettingKey {
  return (GLOBAL_SETTING_KEYS as string[]).includes(key);
}

function isEntrySettingKey(key: string): key is EntrySettingKey {
  return (ENTRY_SETTING_KEYS as string[]).includes(key);
}

/**
 * `/config show|set|reset|entry`. Authorization is already enforced at
 * routeCommand's entry point (authorized user only), and every value is
 * validated by the Zod-backed planners in watchlist/configMutate.ts before
 * anything is written — so an out-of-range or malformed value is rejected
 * with a reason rather than persisted.
 */
async function handleConfig(deps: CommandRouterDeps, invocation: CommandInvocation): Promise<CommandReply> {
  if (!invocation.subcommand || invocation.subcommand === "show") {
    return { embed: buildConfigEmbed(deps.describeSettings()), ephemeral: true };
  }

  const key = invocation.key?.trim();

  if (invocation.subcommand === "set") {
    const value = invocation.value?.trim();
    if (!key || value === undefined) return { content: "Provide both `key` and `value`.", ephemeral: true };
    if (!isGlobalSettingKey(key)) return { content: `Unknown setting \`${key}\`.`, ephemeral: true };

    const outcome = deps.setGlobalSetting(key, value);
    return { content: outcome.ok ? `✅ ${outcome.message}` : `⚠️ ${outcome.message}`, ephemeral: true };
  }

  if (invocation.subcommand === "reset") {
    if (!key) return { content: "Provide a `key`.", ephemeral: true };
    if (!isGlobalSettingKey(key)) return { content: `Unknown setting \`${key}\`.`, ephemeral: true };

    const outcome = deps.resetGlobalSetting(key);
    return { content: outcome.ok ? `✅ ${outcome.message}` : `⚠️ ${outcome.message}`, ephemeral: true };
  }

  if (invocation.subcommand === "entry") {
    const collectionInput = invocation.collection?.trim();
    const value = invocation.value?.trim();
    if (!collectionInput || !key || value === undefined) {
      return { content: "Provide `collection`, `key`, and `value`.", ephemeral: true };
    }
    if (!isEntrySettingKey(key)) return { content: `Unknown per-collection setting \`${key}\`.`, ephemeral: true };

    // Prefer the canonical address so a friendly name still matches the
    // stored entry, but pass the raw input through when resolution fails —
    // planSetEntrySetting also matches on label and id.
    const resolved = await deps.resolveCollection(collectionInput).catch(() => null);
    const outcome = deps.setEntrySetting(resolved?.address ?? collectionInput, key, value);
    return { content: outcome.ok ? `✅ ${outcome.message}` : `⚠️ ${outcome.message}`, ephemeral: true };
  }

  return { content: "Unknown /config subcommand.", ephemeral: true };
}

/** `/portfolio` — READ-ONLY view of a public address. See src/portfolio/portfolio.ts. */
async function handlePortfolio(deps: CommandRouterDeps): Promise<CommandReply> {
  const snapshot = await deps.getPortfolio();
  if (!snapshot) {
    return {
      content:
        "No portfolio address is configured or resolvable. Set `PORTFOLIO_ENS_NAME` (e.g. `yourname.eth`) or `PORTFOLIO_ADDRESS` (a 0x address) in `.env`, then restart. " +
        "This view is strictly read-only — it never needs a private key.",
      ephemeral: true,
    };
  }
  return { embed: buildPortfolioEmbed(snapshot), ephemeral: true };
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
