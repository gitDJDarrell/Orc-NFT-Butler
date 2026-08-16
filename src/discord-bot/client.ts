import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type Guild,
  type SendableChannels,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { NftDeFiAgent } from "../agent/index.js";
import { config } from "../config/env.js";
import { openseaClient, type ResolvedCollection } from "../opensea/client.js";
import type { Alert, CollectionInfo, SaleInfo, Trait } from "../types/index.js";
import type { BidLeadCandidate } from "../watchlist/candidate.js";
import type { BidLeadMonitor, HighestOfferEvent } from "../watchlist/leadMonitor.js";
import type { WatchlistMatch } from "../watchlist/evaluate.js";
import { describeSettings } from "../config/runtime.js";
import { buildPortfolioSnapshot, getCachedPortfolioAddress } from "../portfolio/portfolio.js";
import { planResetGlobalSetting, planSetEntrySetting, planSetGlobalSetting, type PlanResult } from "../watchlist/configMutate.js";
import { planAddEntry, planCreateLeadRule, planRemoveEntry, type LeadRuleCondition, type LeadRuleParams } from "../watchlist/mutate.js";
import { findWatchlistNameMatch } from "../watchlist/resolveInput.js";
import { TraitAutocomplete } from "./traitAutocomplete.js";
import type { AllowlistConfig } from "../watchlist/schema.js";
import { loadWatchlistConfig, saveWatchlistConfig } from "../watchlist/store.js";
import type { WatchedItem } from "../watchlist/watchStore.js";
import type { WhaleActivity } from "../watchlist/whaleStore.js";
import type { RecapSummary } from "../watchlist/recap.js";
import {
  routeCommand,
  type AddWatchlistOutcome,
  type CommandInvocation,
  type CommandName,
  type CommandRouterDeps,
  type CreateLeadRuleOutcome,
  type PendingAddPreview,
  type RemoveWatchlistOutcome,
} from "./commandRouter.js";
import { commandDefinitions } from "./commands.js";
import {
  applyLeadDecision,
  buildAlertEmbed,
  buildBidLeadEmbed,
  buildHighestOfferEmbed,
  buildListingStatusEmbed,
  buildRecapEmbed,
  buildSaleEmbed,
  buildWatchedDelistedEmbed,
  buildWatchedSoldEmbed,
  buildWhaleActivityEmbed,
  toDiscordEmbed,
  type EmbedContent,
  type StatusInfo,
} from "./embeds.js";
import { PendingAddStore } from "./pendingAdds.js";
import { PendingLeadStore } from "./pendingLeads.js";
import { REACTION_ACCEPT, REACTION_DENY, REACTION_WATCH, routeReaction, type ReactionRouterDeps } from "./reactionRouter.js";

export interface DiscordBotClient {
  login(): Promise<void>;
  destroy(): Promise<void>;
  postBidLead(candidate: BidLeadCandidate, match: WatchlistMatch): Promise<void>;
  notifyWatchedChange(candidate: BidLeadCandidate, previousPriceNative: number): Promise<void>;
  notifyWatchedSold(item: WatchedItem, sale: SaleInfo): Promise<void>;
  notifyWatchedDelisted(item: WatchedItem): Promise<void>;
  /** A tracked wallet bought/sold/listed inside an allowlisted collection (Group 3.2). */
  postWhaleActivity(activity: WhaleActivity): Promise<void>;
  /** Twice-daily trend digest, with an optional locally-rendered chart attached. */
  postTrendAlertWithChart(alert: Alert, chart: { label: string; png: Buffer } | undefined): Promise<void>;
  /** Once-daily overnight recap, with up to a handful of charts attached. */
  postRecap(summary: RecapSummary, charts: Array<{ label: string; png: Buffer }>): Promise<void>;
  /** A watched collection's top offer set a new record high. */
  postHighestOffer(event: HighestOfferEvent): Promise<void>;
  /** Returns the posted message's ID (so BidLeadMonitor can anchor future thread recurrence/price-change updates to it), or undefined if nothing was posted. */
  postNewListing(alert: Alert): Promise<string | undefined>;
  postTrendAlert(alert: Alert): Promise<void>;
  postSale(sale: SaleInfo, collectionName: string, ethUsdRate: number | undefined): Promise<void>;
  /**
   * Ensures a thread hangs off a #new-listings anchor message (creating it
   * if needed) and that it holds exactly one living "still listed" status
   * message with the NFT image — editing an existing one in place if
   * `existingStatusMessageId` is still valid, otherwise posting a fresh one.
   * Returns the thread + status message IDs, or undefined on failure.
   */
  postListingRecurrence(params: {
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
  }): Promise<{ threadId: string; statusMessageId: string } | undefined>;
}

/**
 * Builds the real discord.js-backed bot client: gateway connection, bid-lead
 * posting, reaction handling (delegated to reactionRouter.ts), and posting
 * the allowlist-native new-listing/trend-alert signals BidLeadMonitor
 * produces. The existing Discord *webhook* notifier (src/notify/discord.ts)
 * is untouched and keeps firing independently of this client.
 *
 * IMPORTANT: this client intentionally does NOT listen to `agent`'s alert
 * stream (CollectionMonitor / WATCHED_COLLECTIONS) at all — that pipeline is
 * not allowlist-scoped and previously leaked non-allowlisted collections
 * into #trend-alerts. Every collection signal this bot posts now comes from
 * `leadMonitor` (src/watchlist/leadMonitor.ts), which only ever knows about
 * watchlist.json's enabled entries — structurally, not by filter.
 */
export function createDiscordBotClient(agent: NftDeFiAgent, leadMonitor: BidLeadMonitor): DiscordBotClient {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });

  const leads = new PendingLeadStore();
  const pendingAdds = new PendingAddStore();

  /**
   * Defense-in-depth check used by every `postX` method below. `leadMonitor`
   * is already structurally allowlist-scoped (it only ever knows about
   * watchlist.json's enabled entries), so this should never actually reject
   * anything in normal operation — it's a second, independent guard so a
   * future bug in leadMonitor can't silently turn into a Discord post.
   */
  function isAllowlisted(collectionId: string | undefined): boolean {
    if (!collectionId) return false;
    return leadMonitor.getAllowlistedCollections().some((id) => id.toLowerCase() === collectionId.toLowerCase());
  }

  /**
   * Autocomplete for `collection` (every command that takes one) and, for
   * /watchlist create-rule, `trait_category`/`trait_value`. Gated to the
   * authorized user, same posture as actual command invocation — otherwise
   * this would leak watchlist entry names / live OpenSea data to anyone in
   * the guild who can type a slash command, even though they can't actually
   * run one.
   */
  /** Discord's autocomplete response window is ~3s total; leave headroom for the respond() round-trip itself rather than spending the whole budget on the network call. */
  const AUTOCOMPLETE_NETWORK_TIMEOUT_MS = 1800;

  /** Races a promise against a timeout, resolving to `fallback` (never rejecting) if the timeout wins — the underlying call isn't cancelled, it just stops being waited on, so its result still populates caches for next time. */
  function withTimeout<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
    return new Promise<T>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(fallback), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        () => {
          clearTimeout(timer);
          resolvePromise(fallback);
        },
      );
    });
  }

  async function respondToAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    console.log(
      `[discord-bot] Autocomplete fired: user=${interaction.user.id} command=/${interaction.commandName} option=${focused.name} query="${focused.value}"`,
    );

    if (interaction.user.id !== config.DISCORD_AUTHORIZED_USER_ID) {
      console.warn(
        `[discord-bot] Autocomplete rejected — user ${interaction.user.id} is not DISCORD_AUTHORIZED_USER_ID (${config.DISCORD_AUTHORIZED_USER_ID || "not configured"}).`,
      );
      await interaction.respond([]).catch(() => undefined);
      return;
    }

    const query = String(focused.value ?? "");
    let choices: { name: string; value: string }[] = [];

    try {
      if (focused.name === "collection") {
        choices = await buildCollectionChoices(query);
        // Warm the trait catalog for whatever is in the collection field, so
        // the trait dropdowns are usually populated by the time the user
        // tabs into them. Non-blocking and deduped.
        traitAutocomplete.prefetch(interaction.options.getString("collection"));
      } else if (focused.name === "trait_category") {
        choices = traitAutocomplete.buildCategoryChoices(interaction.options.getString("collection"), query);
      } else if (focused.name === "trait_value") {
        choices = traitAutocomplete.buildValueChoices(
          interaction.options.getString("collection"),
          interaction.options.getString("trait_category"),
          query,
        );
      }
    } catch (err) {
      console.warn(`[discord-bot] Autocomplete choice-building failed for option ${focused.name}: ${(err as Error).message}`);
      choices = [];
    }

    // Defensive clamp regardless of how `choices` was built — Discord shows
    // NOTHING, with no client-side error, for a response that violates its
    // limits (>25 choices, or any name/value >100 chars), so this is cheap
    // insurance against exactly the "silently no suggestions" symptom.
    const safeChoices = choices.slice(0, 25).map((c) => ({
      name: c.name.length > 100 ? c.name.slice(0, 100) : c.name,
      value: c.value.length > 100 ? c.value.slice(0, 100) : c.value,
    }));
    console.log(`[discord-bot] Autocomplete responding with ${safeChoices.length} choice(s) for option ${focused.name}.`);

    try {
      await interaction.respond(safeChoices);
    } catch (err) {
      // Most likely cause: the interaction already expired (Discord's ~3s
      // window passed) before we got here — logged so a pattern of these is
      // visible, but there's nothing further to do for this interaction.
      console.warn(`[discord-bot] Failed to respond to autocomplete (interaction may have expired): ${(err as Error).message}`);
    }
  }

  /**
   * Watchlist entries first (their stored address as the value — always
   * resolves cleanly), then live OpenSea search results filling the rest of
   * the 25-choice budget (value = slug — resolveCollectionForCommand's
   * fallback path handles slugs directly). An empty query browses trending
   * collections instead of searching, since /search needs actual text.
   * Search coverage is uneven for small/low-profile collections (only
   * well-known ones reliably match by display name — see
   * OpenSeaClient.searchCollections), so this is a best-effort discovery
   * aid, not a guarantee every real collection will show up. The live call
   * is timeout-guarded so a slow/hung OpenSea response degrades to
   * watchlist-only choices instead of blowing Discord's response window.
   */
  async function buildCollectionChoices(rawQuery: string): Promise<{ name: string; value: string }[]> {
    const query = rawQuery.trim().toLowerCase();
    const matchingEntries = leadMonitor.getEntries().filter((e) => e.enabled && e.label.toLowerCase().includes(query));
    const watchlistChoices = matchingEntries.map((e) => ({
      name: `${e.label.length > 85 ? `${e.label.slice(0, 82)}...` : e.label} (watchlist)`,
      value: e.collection,
    }));

    const remaining = 25 - watchlistChoices.length;
    if (remaining <= 0) return watchlistChoices.slice(0, 25);

    const searchResults = await withTimeout(
      query.length > 0 ? openseaClient.searchCollections(query, remaining) : openseaClient.getTrendingCollections(remaining),
      [],
      AUTOCOMPLETE_NETWORK_TIMEOUT_MS,
    );
    const watchlistAddresses = new Set(matchingEntries.map((e) => e.collection.toLowerCase()));
    const searchChoices = searchResults
      .filter((r) => !watchlistAddresses.has(r.slug.toLowerCase()))
      .map((r) => ({ name: r.name.length > 100 ? r.name.slice(0, 100) : r.name, value: r.slug }));

    return [...watchlistChoices, ...searchChoices].slice(0, 25);
  }

  /**
   * Trait suggestions are served from a per-collection catalog cached by
   * TraitAutocomplete — synchronous, no network on the keystroke path. See
   * traitAutocomplete.ts for why the previous live-fetch-per-keystroke
   * approach silently produced an empty dropdown.
   */
  const traitAutocomplete = new TraitAutocomplete({
    resolveCollection: (input) => openseaClient.resolveCollection(input),
    getCollectionTraits: (idOrSlug) => openseaClient.getCollectionTraits(idOrSlug),
    // Lets a typed watchlist display name ("Super Punk World") resolve to its
    // stored address, the same order resolveCollectionForCommand uses.
    findWatchlistCollection: (input) => findWatchlistNameMatch(input, leadMonitor.getEntries())?.collection ?? null,
  });

  /** /watchlist add: mutates watchlist.json on disk and reloads the live BidLeadMonitor, without dropping the gateway connection. */
  function addWatchlistEntry(resolved: ResolvedCollection, floor: CollectionInfo | null, trait?: Trait): AddWatchlistOutcome {
    try {
      const cfg = loadWatchlistConfig(config.WATCHLIST_CONFIG_PATH);
      const result = planAddEntry(cfg, resolved, floor, trait);
      if (!result.ok) return { ok: false, message: result.message };

      saveWatchlistConfig(result.config, config.WATCHLIST_CONFIG_PATH);
      leadMonitor.reload();
      return {
        ok: true,
        message: `Added ${resolved.name}${trait ? ` scoped to ${trait.key}: ${trait.value}` : ""}.`,
        entry: result.entry,
      };
    } catch (err) {
      return { ok: false, message: `Failed to add to watchlist.json: ${(err as Error).message}` };
    }
  }

  const ADD_CONFIRM_PREFIX = "watchlist-add-confirm:";
  const ADD_CANCEL_PREFIX = "watchlist-add-cancel:";

  /** Builds the Confirm/Cancel row for a /watchlist add preview, registering it under a fresh token in PendingAddStore first (the token has to exist before the buttons' custom IDs can be built). */
  function buildAddConfirmationRow(pendingAdd: PendingAddPreview): ActionRowBuilder<ButtonBuilder> {
    const token = randomUUID();
    pendingAdds.add(token, pendingAdd.resolved, pendingAdd.floor, pendingAdd.trait);

    const confirm = new ButtonBuilder().setCustomId(`${ADD_CONFIRM_PREFIX}${token}`).setLabel("Confirm add").setStyle(ButtonStyle.Success);
    const cancel = new ButtonBuilder().setCustomId(`${ADD_CANCEL_PREFIX}${token}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary);
    return new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel);
  }

  /**
   * Handles a click on either button from buildAddConfirmationRow.
   * Authorized-user-only, mirroring routeCommand's own gate — belt-and-
   * braces, since these buttons only ever appear on an ephemeral reply only
   * the authorized user can see in the first place.
   */
  async function handleAddConfirmationButton(interaction: ButtonInteraction): Promise<void> {
    const isConfirm = interaction.customId.startsWith(ADD_CONFIRM_PREFIX);
    const isCancel = interaction.customId.startsWith(ADD_CANCEL_PREFIX);
    if (!isConfirm && !isCancel) return;

    if (interaction.user.id !== config.DISCORD_AUTHORIZED_USER_ID) {
      await interaction.reply({ content: "⛔ You're not authorized to use this bot.", ephemeral: true }).catch(() => undefined);
      return;
    }

    const token = interaction.customId.slice((isConfirm ? ADD_CONFIRM_PREFIX : ADD_CANCEL_PREFIX).length);
    const pending = pendingAdds.get(token);
    pendingAdds.remove(token);

    if (!pending) {
      await interaction
        .update({ content: "This preview has expired (bot restarted, or already actioned) — run `/watchlist add` again.", embeds: [], components: [] })
        .catch(() => undefined);
      return;
    }

    if (isCancel) {
      await interaction.update({ content: "❌ Cancelled — nothing was added.", embeds: [], components: [] }).catch(() => undefined);
      return;
    }

    const outcome = addWatchlistEntry(pending.resolved, pending.floor, pending.trait);
    const floorText = pending.floor ? ` Current floor: ${pending.floor.floorPriceNative} ${pending.floor.floorPriceCurrency}.` : "";
    const traitText = pending.trait ? ` Scoped to **${pending.trait.key}: ${pending.trait.value}**.` : "";
    const content = outcome.ok
      ? `✅ Added **${pending.resolved.name}** (\`${pending.resolved.address}\`) to the watchlist.${traitText}${floorText}`
      : outcome.message;
    await interaction.update({ content, embeds: [], components: [] }).catch(() => undefined);
  }

  // --- Bid-lead card buttons (Accept/Deny/Watch) ---
  // The Discord message ID IS the PendingLeadStore key, so (unlike the
  // /watchlist add preview above) these buttons embed it directly rather
  // than needing a separate token store. Accept alone gets a confirm step
  // — the two-step pattern live bidding will reuse later — Deny/Watch
  // register immediately, same as reacting today.
  const LEAD_ACCEPT_PREFIX = "lead-accept:";
  const LEAD_ACCEPT_YES_PREFIX = "lead-accept-yes:";
  const LEAD_ACCEPT_NO_PREFIX = "lead-accept-no:";
  const LEAD_DENY_PREFIX = "lead-deny:";
  const LEAD_WATCH_PREFIX = "lead-watch:";

  function buildLeadDecisionRow(messageId: string, disabled = false): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${LEAD_ACCEPT_PREFIX}${messageId}`).setLabel("Accept").setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${LEAD_DENY_PREFIX}${messageId}`).setLabel("Deny").setStyle(ButtonStyle.Danger).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${LEAD_WATCH_PREFIX}${messageId}`).setLabel("Watch").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    );
  }

  /** Ephemeral Confirm/Cancel prompt for the Accept button — nothing is registered until Confirm is clicked. */
  async function promptAcceptConfirmation(interaction: ButtonInteraction, messageId: string): Promise<void> {
    const lead = leads.get(messageId);
    if (!lead || lead.status !== "pending") {
      await interaction
        .reply({ content: lead ? `This lead was already marked **${lead.status}**.` : "This lead is no longer tracked (bot restarted?).", ephemeral: true })
        .catch(() => undefined);
      return;
    }

    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${LEAD_ACCEPT_YES_PREFIX}${messageId}`).setLabel("Confirm accept").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${LEAD_ACCEPT_NO_PREFIX}${messageId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    );

    await interaction
      .reply({
        content:
          `Confirm accepting **${lead.candidate.collectionName} #${lead.candidate.tokenId}** at ` +
          `${lead.candidate.priceNative} ${lead.candidate.priceCurrency}? This builds a **DRY-RUN** order only — nothing is signed or broadcast.`,
        components: [confirmRow],
        ephemeral: true,
      })
      .catch(() => undefined);
  }

  /** Runs the actual accept (same routeReaction path a ✅ reaction takes) after Confirm is clicked. */
  async function finalizeAccept(interaction: ButtonInteraction, messageId: string): Promise<void> {
    const lead = leads.get(messageId);
    if (!lead || lead.status !== "pending") {
      await interaction
        .update({ content: lead ? `Already marked **${lead.status}** — no action taken.` : "No longer tracked.", components: [] })
        .catch(() => undefined);
      return;
    }

    await routeReaction(routerDeps, { messageId, emoji: REACTION_ACCEPT, userId: interaction.user.id, username: interaction.user.username });
    await interaction.update({ content: "✅ Confirmed — dry-run order built.", components: [] }).catch(() => undefined);
  }

  /**
   * Handles Accept/Deny/Watch (and Accept's Confirm/Cancel) button clicks.
   * Authorized-user-only, same gate as reactions/commands — a button is
   * visible to everyone in the channel, so this is the only thing standing
   * between "anyone can click it" and "only the operator's click counts."
   */
  async function handleLeadDecisionButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.user.id !== config.DISCORD_AUTHORIZED_USER_ID) {
      await interaction.reply({ content: "⛔ You're not authorized to use this bot.", ephemeral: true }).catch(() => undefined);
      return;
    }

    const id = interaction.customId;
    if (id.startsWith(LEAD_ACCEPT_YES_PREFIX)) {
      await finalizeAccept(interaction, id.slice(LEAD_ACCEPT_YES_PREFIX.length));
      return;
    }
    if (id.startsWith(LEAD_ACCEPT_NO_PREFIX)) {
      await interaction.update({ content: "Cancelled — lead left pending.", components: [] }).catch(() => undefined);
      return;
    }
    if (id.startsWith(LEAD_ACCEPT_PREFIX)) {
      await promptAcceptConfirmation(interaction, id.slice(LEAD_ACCEPT_PREFIX.length));
      return;
    }
    if (id.startsWith(LEAD_DENY_PREFIX)) {
      const messageId = id.slice(LEAD_DENY_PREFIX.length);
      await routeReaction(routerDeps, { messageId, emoji: REACTION_DENY, userId: interaction.user.id, username: interaction.user.username });
      await interaction.reply({ content: "❌ Denied.", ephemeral: true }).catch(() => undefined);
      return;
    }
    if (id.startsWith(LEAD_WATCH_PREFIX)) {
      const messageId = id.slice(LEAD_WATCH_PREFIX.length);
      await routeReaction(routerDeps, { messageId, emoji: REACTION_WATCH, userId: interaction.user.id, username: interaction.user.username });
      await interaction.reply({ content: "👀 Watching.", ephemeral: true }).catch(() => undefined);
      return;
    }
  }

  /** /watchlist remove: same disk-write-then-reload flow as add. */
  function removeWatchlistEntry(input: string, resolvedAddress: string | null): RemoveWatchlistOutcome {
    try {
      const cfg = loadWatchlistConfig(config.WATCHLIST_CONFIG_PATH);
      const result = planRemoveEntry(cfg, input, resolvedAddress);
      if (!result.ok) return { ok: false, message: result.message };

      saveWatchlistConfig(result.config, config.WATCHLIST_CONFIG_PATH);
      leadMonitor.reload();
      return {
        ok: true,
        message: `🗑️ Removed **${result.removed.label}** (\`${result.removed.collection}\`) from the watchlist.`,
        removed: result.removed,
      };
    } catch (err) {
      return { ok: false, message: `Failed to remove from watchlist.json: ${(err as Error).message}` };
    }
  }

  /** /watchlist create-rule: same disk-write-then-reload flow as add/remove. */
  function createLeadRule(resolved: ResolvedCollection, params: LeadRuleParams): CreateLeadRuleOutcome {
    try {
      const cfg = loadWatchlistConfig(config.WATCHLIST_CONFIG_PATH);
      const result = planCreateLeadRule(cfg, resolved, params);
      if (!result.ok) return { ok: false, message: result.message };

      saveWatchlistConfig(result.config, config.WATCHLIST_CONFIG_PATH);
      leadMonitor.reload();
      return { ok: true, message: `Created lead rule for ${resolved.name}.`, entry: result.entry };
    } catch (err) {
      return { ok: false, message: `Failed to write lead rule to watchlist.json: ${(err as Error).message}` };
    }
  }

  /**
   * Shared write path for every `/config` mutation: plan (validated) ->
   * save watchlist.json -> reload the live monitor. Identical shape to the
   * /watchlist add|remove flow, so a config change takes effect immediately
   * without dropping the gateway connection.
   */
  function applyConfigPlan(plan: (cfg: AllowlistConfig) => PlanResult<unknown>, describe: (detail: unknown) => string): { ok: boolean; message: string } {
    try {
      const cfg = loadWatchlistConfig(config.WATCHLIST_CONFIG_PATH);
      const result = plan(cfg);
      if (!result.ok) return { ok: false, message: result.message };

      saveWatchlistConfig(result.config, config.WATCHLIST_CONFIG_PATH);
      // reload() re-applies the settings overrides process-wide AND
      // reschedules the trend/recap digests if their times changed.
      leadMonitor.reload();
      return { ok: true, message: describe(result.detail) };
    } catch (err) {
      return { ok: false, message: `Failed to update watchlist.json: ${(err as Error).message}` };
    }
  }

  function getStatusInfo(): StatusInfo {
    return {
      dryRun: config.DRY_RUN,
      hasOpenSeaKey: config.hasOpenSeaKey,
      watchlistCount: leadMonitor.getAllowlistedCollections().length,
      discordWebhookEnabled: config.discordEnabled,
      nextTrendCheckAt: leadMonitor.getNextTrendCheckTime(),
      pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
      trendAlertTimes: config.TREND_ALERT_TIMES,
      uptimeSeconds: leadMonitor.getUptimeSeconds(),
      lastPollAt: leadMonitor.getLastPollAt(),
      lastTrendCheckAt: leadMonitor.getLastTrendCheckAt(),
      rateLimitHealth: openseaClient.getRateLimitHealth(),
      activitySummary: leadMonitor.getActivitySummary(),
      watchedItemCount: leadMonitor.getWatchedItems().length,
      whaleCount: leadMonitor.getWhales().length,
      lastRecapAt: leadMonitor.getLastRecapAt(),
      nextRecapAt: leadMonitor.getNextRecapTime(),
      chartsEnabled: config.TREND_CHARTS_ENABLED,
      // Read from the cache only — /status must never block on an ENS RPC
      // round-trip. It populates after the first /portfolio (or startup
      // pre-resolution in index.ts).
      portfolioAddress: getCachedPortfolioAddress()?.address ?? null,
      portfolioEnsName: getCachedPortfolioAddress()?.ensName ?? null,
    };
  }

  const commandDeps: CommandRouterDeps = {
    authorizedUserId: config.DISCORD_AUTHORIZED_USER_ID,
    resolveCollection: (input) => openseaClient.resolveCollection(input),
    getFloor: (address) => openseaClient.getFloorPrice(address),
    getListings: (address, limit) => openseaClient.getRecentListings(address, limit),
    getOffers: (address, limit) => openseaClient.getCollectionOffers(address, limit),
    getCollectionImage: (address) => openseaClient.getCollectionImage(address),
    getEthUsdRate: () => openseaClient.getEthUsdRate(),
    listWatchlistEntries: () => leadMonitor.getEntries(),
    addWatchlistEntry,
    getCollectionTraits: (idOrSlug) => openseaClient.getCollectionTraits(idOrSlug),
    removeWatchlistEntry,
    createLeadRule,
    getStatusInfo,

    // --- Group 3 ---
    listWatchedItems: () => leadMonitor.getWatchedItems(),
    removeWatchedItem: (collectionId, tokenId) => leadMonitor.removeWatchedSubject(collectionId, tokenId),
    addWhale: (address, label) => leadMonitor.addWhale(address, label),
    removeWhale: (address) => leadMonitor.removeWhale(address),
    listWhales: () => leadMonitor.getWhales(),
    describeSettings: () => describeSettings(),
    setGlobalSetting: (key, value) =>
      applyConfigPlan(
        (cfg) => planSetGlobalSetting(cfg, key, value),
        (detail) => {
          const d = detail as { key: string; value: unknown };
          return `Set \`${d.key}\` to **${String(d.value)}** — in effect now, persisted to watchlist.json.`;
        },
      ),
    resetGlobalSetting: (key) =>
      applyConfigPlan(
        (cfg) => planResetGlobalSetting(cfg, key),
        (detail) => `Reset \`${(detail as { key: string }).key}\` — now using the .env value again.`,
      ),
    setEntrySetting: (collectionMatcher, key, value) =>
      applyConfigPlan(
        (cfg) => planSetEntrySetting(cfg, collectionMatcher, key, value),
        (detail) => {
          const d = detail as { label: string; key: string; value: unknown };
          return `Set \`${d.key}\` to **${String(d.value)}** on **${d.label}**.`;
        },
      ),
    getPortfolio: () => buildPortfolioSnapshot(),
  };

  async function getChannel(channelId: string): Promise<SendableChannels | null> {
    if (!channelId) return null;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isSendable()) return channel;
      console.warn(`[discord-bot] Channel ${channelId} was not found or is not a text channel.`);
      return null;
    } catch (err) {
      console.warn(`[discord-bot] Failed to fetch channel ${channelId}: ${(err as Error).message}`);
      return null;
    }
  }

  async function sendEmbed(channelId: string, content: string | undefined, embed?: EmbedContent): Promise<void> {
    const channel = await getChannel(channelId);
    if (!channel) return;
    try {
      await channel.send({ content, embeds: embed ? [toDiscordEmbed(embed)] : undefined });
    } catch (err) {
      console.warn(`[discord-bot] Failed to send to channel ${channelId}: ${(err as Error).message}`);
    }
  }

  /** Filename-safe slug for a chart attachment — Discord's `attachment://` reference only matches on an exact, simple name. */
  function chartFileName(label: string, index: number): string {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 40) || "chart";
    return `${slug}-${index}.png`;
  }

  /**
   * Sends one or more embeds with locally-rendered PNG charts attached.
   * Charts are referenced via `attachment://<name>`, which is what makes
   * Discord render the image inline in the embed rather than as a separate
   * file card below it.
   */
  async function sendEmbedsWithCharts(
    channelId: string,
    embeds: EmbedContent[],
    charts: Array<{ label: string; png: Buffer }>,
  ): Promise<void> {
    const channel = await getChannel(channelId);
    if (!channel) return;

    const files = charts.map((c, i) => ({ attachment: c.png, name: chartFileName(c.label, i) }));
    try {
      await channel.send({
        embeds: embeds.map((e) => toDiscordEmbed(e)),
        files: files.length > 0 ? files : undefined,
      });
    } catch (err) {
      console.warn(`[discord-bot] Failed to send charted message to channel ${channelId}: ${(err as Error).message}`);
      // A rejected attachment (size, transient upload failure) shouldn't
      // cost the operator the digest itself — retry text-only once.
      if (files.length > 0) {
        try {
          await channel.send({ embeds: embeds.map((e) => toDiscordEmbed({ ...e, image: undefined })) });
        } catch (retryErr) {
          console.warn(`[discord-bot] Text-only retry also failed for channel ${channelId}: ${(retryErr as Error).message}`);
        }
      }
    }
  }

  const routerDeps: ReactionRouterDeps = {
    authorizedUserId: config.DISCORD_AUTHORIZED_USER_ID,
    leads,
    submitOrder: (raw) => agent.submitOrder(raw),
    postToOrderLog: async (content, embed) => sendEmbed(config.DISCORD_ORDER_LOG_CHANNEL_ID, content, embed),
    postToAuditLog: async (content) => sendEmbed(config.DISCORD_AUDIT_LOG_CHANNEL_ID, content),
    replyToLead: async (messageId, content, embed) => {
      const channel = await getChannel(config.DISCORD_BID_LEADS_CHANNEL_ID);
      if (!channel) return;
      try {
        const message = await channel.messages.fetch(messageId);
        await message.reply({ content, embeds: embed ? [toDiscordEmbed(embed)] : undefined });
      } catch (err) {
        console.warn(`[discord-bot] Failed to reply to lead message ${messageId}: ${(err as Error).message}`);
      }
    },
    annotateLeadMessage: async (messageId, decision, detail) => {
      const channel = await getChannel(config.DISCORD_BID_LEADS_CHANNEL_ID);
      if (!channel) return;
      try {
        const message = await channel.messages.fetch(messageId);
        const existing = message.embeds[0];
        if (!existing) return;
        const currentContent: EmbedContent = {
          title: existing.title ?? "",
          description: existing.description ?? undefined,
          color: existing.color ?? 0,
          fields: existing.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline })),
          footer: existing.footer?.text,
          image: existing.image?.url,
          thumbnail: existing.thumbnail?.url,
        };
        const updated = applyLeadDecision(currentContent, decision, detail);
        // The buttons stay visible (disabled) rather than vanishing — a
        // record of what options WERE there, and a clear "this is settled"
        // signal at a glance.
        await message.edit({ embeds: [toDiscordEmbed(updated)], components: [buildLeadDecisionRow(messageId, true)] });
      } catch (err) {
        console.warn(`[discord-bot] Failed to annotate lead message ${messageId}: ${(err as Error).message}`);
      }
    },
    watchCandidate: (candidate) => {
      leadMonitor.addWatchedSubject(candidate.collectionId, candidate.collectionName, candidate.tokenId, candidate.priceNative, candidate.priceCurrency);
    },
  };

  async function registerSlashCommands(): Promise<void> {
    const guildId = config.DISCORD_GUILD_ID;
    const guilds: Guild[] = guildId
      ? [client.guilds.cache.get(guildId)].filter((g): g is Guild => g !== undefined)
      : [...client.guilds.cache.values()];

    if (guilds.length === 0) {
      console.warn(
        `[discord-bot] No guild to register slash commands in${guildId ? ` (DISCORD_GUILD_ID=${guildId} doesn't match a guild this bot is in)` : " (bot isn't in any guild)"}.`,
      );
      return;
    }

    for (const guild of guilds) {
      try {
        await guild.commands.set(commandDefinitions);
        console.log(`[discord-bot] Registered ${commandDefinitions.length} slash commands in guild "${guild.name}" (${guild.id}).`);
      } catch (err) {
        console.error(
          `[discord-bot] Failed to register slash commands in guild "${guild.name}" (${guild.id}): ${(err as Error).message}. ` +
            "If this says \"Missing Access\", the bot needs to be re-invited/re-authorized with the applications.commands scope — see README \"Discord bot\" section.",
        );
      }
    }
  }

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[discord-bot] Connected as ${readyClient.user.tag}`);
    await registerSlashCommands();
    await sendEmbed(
      config.DISCORD_STATUS_CHANNEL_ID,
      `🟢 NFT/DeFi Agent bot online — mode=${config.DRY_RUN ? "DRY-RUN" : "LIVE (unsupported — treated as DRY-RUN)"}, data source=${
        config.hasOpenSeaKey ? "OpenSea live API" : "mock data"
      }, allowlisted collections=${leadMonitor.getAllowlistedCollections().length}.`,
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      await respondToAutocomplete(interaction);
      return;
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith(ADD_CONFIRM_PREFIX) || interaction.customId.startsWith(ADD_CANCEL_PREFIX)) {
        await handleAddConfirmationButton(interaction);
      } else {
        await handleLeadDecisionButton(interaction);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    const invocation: CommandInvocation = {
      commandName: interaction.commandName as CommandName,
      subcommand: (interaction.options.getSubcommand(false) as CommandInvocation["subcommand"]) ?? undefined,
      collection: interaction.options.getString("collection") ?? undefined,
      hours: interaction.options.getInteger("hours") ?? undefined,
      condition: (interaction.options.getString("condition") as LeadRuleCondition | null) ?? undefined,
      price: interaction.options.getNumber("price") ?? undefined,
      percentile: interaction.options.getNumber("percentile") ?? undefined,
      traitCategory: interaction.options.getString("trait_category") ?? undefined,
      traitValue: interaction.options.getString("trait_value") ?? undefined,
      tokenId: interaction.options.getString("token_id") ?? undefined,
      address: interaction.options.getString("address") ?? undefined,
      label: interaction.options.getString("label") ?? undefined,
      key: interaction.options.getString("key") ?? undefined,
      value: interaction.options.getString("value") ?? undefined,
      userId: interaction.user.id,
      username: interaction.user.username,
    };

    try {
      await interaction.deferReply({ ephemeral: true });
      const reply = await routeCommand(commandDeps, invocation);
      await interaction.editReply({
        content: reply.content,
        embeds: reply.embed ? [toDiscordEmbed(reply.embed)] : undefined,
        components: reply.pendingAdd ? [buildAddConfirmationRow(reply.pendingAdd)] : [],
      });
    } catch (err) {
      console.error(`[discord-bot] Failed to handle /${interaction.commandName}: ${(err as Error).message}`);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: "Something went wrong handling that command." });
        } else {
          await interaction.reply({ content: "Something went wrong handling that command.", ephemeral: true });
        }
      } catch {
        // best effort — the interaction may have already expired
      }
    }
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (user.partial) await user.fetch();
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch (err) {
      console.warn(`[discord-bot] Failed to fetch partial reaction data: ${(err as Error).message}`);
      return;
    }

    if (user.bot) return;
    if (reaction.message.channelId !== config.DISCORD_BID_LEADS_CHANNEL_ID) return;

    await routeReaction(routerDeps, {
      messageId: reaction.message.id,
      emoji: reaction.emoji.name ?? "",
      userId: user.id,
      username: user.username ?? user.id,
    });
  });

  return {
    async login() {
      await client.login(config.DISCORD_BOT_TOKEN);
    },
    async destroy() {
      await client.destroy();
    },
    async postBidLead(candidate, match) {
      // Defense in depth: BidLeadMonitor only ever generates candidates for
      // allowlisted collections, but every emission path checks explicitly.
      if (!isAllowlisted(candidate.collectionId)) {
        console.warn(`[discord-bot] Refusing to post bid lead for non-allowlisted collection ${candidate.collectionId}.`);
        return;
      }
      if (!config.DISCORD_BID_LEADS_CHANNEL_ID) {
        console.warn("[discord-bot] DISCORD_BID_LEADS_CHANNEL_ID not configured — dropping bid lead.");
        return;
      }
      const channel = await getChannel(config.DISCORD_BID_LEADS_CHANNEL_ID);
      if (!channel) {
        console.warn("[discord-bot] Bid-leads channel unreachable — dropping bid lead.");
        return;
      }
      try {
        const message = await channel.send({ embeds: [toDiscordEmbed(buildBidLeadEmbed(candidate, match))] });
        leads.add(message.id, candidate, match);
        // The button row's custom IDs embed the message ID, so it can only
        // be built once the message (and therefore its ID) exists — hence
        // send, then edit to attach it, rather than one combined send.
        await message.edit({ components: [buildLeadDecisionRow(message.id)] });
        await message.react(REACTION_ACCEPT);
        await message.react(REACTION_DENY);
        await message.react(REACTION_WATCH);
      } catch (err) {
        console.warn(`[discord-bot] Failed to post bid lead: ${(err as Error).message}`);
      }
    },
    async notifyWatchedChange(candidate, previousPriceNative) {
      if (!isAllowlisted(candidate.collectionId)) return;
      const direction = candidate.priceNative < previousPriceNative ? "📉 Price DROP" : "📈 Price rise";
      await sendEmbed(
        config.DISCORD_BID_LEADS_CHANNEL_ID,
        `👀 ${direction} on a watched item — ${candidate.collectionName} #${candidate.tokenId}: ` +
          `${previousPriceNative} → ${candidate.priceNative} ${candidate.priceCurrency}.`,
      );
    },
    async notifyWatchedSold(item, sale) {
      if (!isAllowlisted(item.collectionId)) return;
      const ethUsdRate = await openseaClient.getEthUsdRate();
      await sendEmbed(config.DISCORD_BID_LEADS_CHANNEL_ID, undefined, buildWatchedSoldEmbed(item, sale, ethUsdRate));
    },
    async notifyWatchedDelisted(item) {
      if (!isAllowlisted(item.collectionId)) return;
      const ethUsdRate = await openseaClient.getEthUsdRate();
      await sendEmbed(config.DISCORD_BID_LEADS_CHANNEL_ID, undefined, buildWatchedDelistedEmbed(item, ethUsdRate));
    },
    async postWhaleActivity(activity) {
      // Defense in depth: BidLeadMonitor only ever scans allowlisted
      // collections, but every emission path checks explicitly.
      if (!isAllowlisted(activity.collectionId)) {
        console.warn(`[discord-bot] Refusing to post whale activity for non-allowlisted collection ${activity.collectionId}.`);
        return;
      }
      const channelId = config.DISCORD_WHALE_CHANNEL_ID || config.DISCORD_BID_LEADS_CHANNEL_ID;
      await sendEmbed(channelId, undefined, buildWhaleActivityEmbed(activity));
    },
    async postTrendAlertWithChart(alert, chart) {
      if (!isAllowlisted(alert.collectionId)) {
        console.warn(`[discord-bot] Refusing to post trend alert for non-allowlisted collection ${alert.collectionId}.`);
        return;
      }

      const embed = buildAlertEmbed(alert);
      if (!chart) {
        await sendEmbed(config.DISCORD_TREND_ALERTS_CHANNEL_ID, undefined, embed);
        return;
      }

      // Point the embed's image at the attachment we're uploading alongside it.
      const name = chartFileName(chart.label, 0);
      await sendEmbedsWithCharts(config.DISCORD_TREND_ALERTS_CHANNEL_ID, [{ ...embed, image: `attachment://${name}` }], [chart]);
    },
    async postHighestOffer(event) {
      // Defense in depth: leadMonitor only ever evaluates allowlisted
      // collections, but every emission path checks explicitly.
      if (!isAllowlisted(event.collectionId)) {
        console.warn(`[discord-bot] Refusing to post highest offer for non-allowlisted collection ${event.collectionId}.`);
        return;
      }
      const channelId = config.DISCORD_HIGHEST_OFFERS_CHANNEL_ID || config.DISCORD_TREND_ALERTS_CHANNEL_ID;
      await sendEmbed(channelId, undefined, buildHighestOfferEmbed(event));
    },
    async postRecap(summary, charts) {
      const channelId = config.DISCORD_RECAP_CHANNEL_ID || config.DISCORD_TREND_ALERTS_CHANNEL_ID;
      const embed = buildRecapEmbed(summary);

      if (charts.length === 0) {
        await sendEmbed(channelId, undefined, embed);
        return;
      }

      // The summary embed carries the first chart inline; the rest upload as
      // additional attachments on the same message.
      const firstName = chartFileName(charts[0]!.label, 0);
      await sendEmbedsWithCharts(channelId, [{ ...embed, image: `attachment://${firstName}` }], charts);
    },
    async postNewListing(alert) {
      // Defense in depth: leadMonitor only ever produces this for allowlisted
      // collections, but every emission path checks explicitly.
      if (!isAllowlisted(alert.collectionId)) {
        console.warn(`[discord-bot] Refusing to post new-listing alert for non-allowlisted collection ${alert.collectionId}.`);
        return undefined;
      }
      const channel = await getChannel(config.DISCORD_NEW_LISTINGS_CHANNEL_ID);
      if (!channel) return undefined;
      try {
        const message = await channel.send({ embeds: [toDiscordEmbed(buildAlertEmbed(alert))] });
        return message.id;
      } catch (err) {
        console.warn(`[discord-bot] Failed to post new-listing alert: ${(err as Error).message}`);
        return undefined;
      }
    },
    async postTrendAlert(alert) {
      if (!isAllowlisted(alert.collectionId)) {
        console.warn(`[discord-bot] Refusing to post trend alert for non-allowlisted collection ${alert.collectionId}.`);
        return;
      }
      await sendEmbed(config.DISCORD_TREND_ALERTS_CHANNEL_ID, undefined, buildAlertEmbed(alert));
    },
    async postSale(sale, collectionName, ethUsdRate) {
      // Defense in depth: leadMonitor only ever produces this for allowlisted
      // collections, but every emission path checks explicitly.
      if (!isAllowlisted(sale.collectionId)) {
        console.warn(`[discord-bot] Refusing to post sale for non-allowlisted collection ${sale.collectionId}.`);
        return;
      }
      await sendEmbed(config.DISCORD_SALES_CHANNEL_ID, undefined, buildSaleEmbed(sale, collectionName, ethUsdRate));
    },
    async postListingRecurrence({
      tokenId,
      collectionName,
      anchorMessageId,
      existingThreadId,
      existingStatusMessageId,
      priceNative,
      priceCurrency,
      imageUrl,
      seenCount,
      lastSeenAt,
      ethUsdRate,
    }) {
      const channel = await getChannel(config.DISCORD_NEW_LISTINGS_CHANNEL_ID);
      if (!channel) return undefined;

      try {
        let thread = null;
        if (existingThreadId) {
          const existing = await client.channels.fetch(existingThreadId).catch(() => null);
          if (existing?.isThread() && existing.isSendable()) thread = existing;
          // Stored thread is gone/unusable (e.g. deleted, archived past recovery) — fall through and start a fresh one.
        }

        if (!thread) {
          const anchorMessage = await channel.messages.fetch(anchorMessageId).catch(() => null);
          if (!anchorMessage) return undefined;

          thread = await anchorMessage.startThread({
            name: `Listing history — #${tokenId}`.slice(0, 100),
            autoArchiveDuration: 10080, // 7 days
          });
        }

        const statusEmbed = toDiscordEmbed(
          buildListingStatusEmbed({ collectionName, tokenId, priceNative, priceCurrency, imageUrl, seenCount, lastSeenAt, ethUsdRate }),
        );

        if (existingStatusMessageId) {
          const existingStatus = await thread.messages.fetch(existingStatusMessageId).catch(() => null);
          if (existingStatus) {
            await existingStatus.edit({ embeds: [statusEmbed] });
            return { threadId: thread.id, statusMessageId: existingStatus.id };
          }
          // Stored status message is gone (deleted) — fall through and post a fresh one.
        }

        const statusMessage = await thread.send({ embeds: [statusEmbed] });
        return { threadId: thread.id, statusMessageId: statusMessage.id };
      } catch (err) {
        console.warn(`[discord-bot] Failed to post/update listing recurrence status for token ${tokenId}: ${(err as Error).message}`);
        return undefined;
      }
    },
  };
}
