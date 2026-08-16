import { EmbedBuilder } from "discord.js";
import { formatPriceWithUsd, type ResolvedCollection } from "../opensea/client.js";
import type { RateLimitHealth } from "../opensea/requestScheduler.js";
import type { Alert, CollectionInfo, CollectionOfferInfo, DryRunResult, ListingInfo, SaleInfo, Trait } from "../types/index.js";
import type { PortfolioSnapshot } from "../portfolio/portfolio.js";
import type { BidLeadCandidate } from "../watchlist/candidate.js";
import type { WatchlistMatch } from "../watchlist/evaluate.js";
import type { HighestOfferEvent } from "../watchlist/leadMonitor.js";
import type { RecapCollectionLine, RecapSummary } from "../watchlist/recap.js";
import type { AllowlistEntry } from "../watchlist/schema.js";
import type { WatchedItem } from "../watchlist/watchStore.js";
import type { WhaleActivity, WhaleWallet } from "../watchlist/whaleStore.js";

/**
 * Framework-agnostic embed content — built and unit-testable without
 * touching discord.js. `toDiscordEmbed()` is the only function here that
 * constructs a real discord.js object, and does no I/O.
 */
export interface EmbedFieldContent {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedContent {
  title: string;
  description?: string;
  color: number;
  fields: EmbedFieldContent[];
  footer?: string;
  /** Main embed image — the large image below the fields. Best-effort; omitted if unavailable. */
  image?: string;
  /** Small corner thumbnail, used for collection-level content (trend digests, offers). */
  thumbnail?: string;
  /** ISO timestamp rendered as the embed's native (localized, clock-icon) timestamp. */
  timestamp?: string;
}

const COLOR_LEAD = 0x6ea8fe;
const COLOR_ACCEPT = 0x67c23a;
const COLOR_WARN = 0xe6a23c;
const COLOR_INFO = 0x67c23a;
const COLOR_NEUTRAL = 0x8a91a3;
const COLOR_DENIED = 0x4a4d57;
const COLOR_WATCHING = 0x5865f2;

export type LeadDecision = "accepted" | "denied" | "watching";

const DECISION_BADGE: Record<LeadDecision, { emoji: string; label: string; color: number }> = {
  accepted: { emoji: "✅", label: "ACCEPTED", color: COLOR_ACCEPT },
  denied: { emoji: "❌", label: "DENIED", color: COLOR_DENIED },
  watching: { emoji: "👀", label: "WATCHING", color: COLOR_WATCHING },
};

/**
 * Rewrites a posted bid-lead embed to show its decision at a glance — a
 * badge prefixed onto the title, a status color, and (denied only) a
 * struck-through description — rather than a footer note easy to miss when
 * skimming a busy channel. Pure/testable; the caller (client.ts) re-fetches
 * the live embed's current content, runs it through this, and re-posts.
 */
export function applyLeadDecision(embed: EmbedContent, decision: LeadDecision, detail?: string): EmbedContent {
  const badge = DECISION_BADGE[decision];
  const strike = (text: string) =>
    text
      .split("\n")
      .map((line) => (line.trim() ? `~~${line}~~` : line))
      .join("\n");

  return {
    ...embed,
    title: `${badge.emoji} ${badge.label} — ${embed.title}`,
    color: badge.color,
    description: embed.description && decision === "denied" ? strike(embed.description) : embed.description,
    footer: detail ? (embed.footer ? `${embed.footer} · ${detail}` : detail) : embed.footer,
  };
}

/** Appends a compact "USD is a live estimate" footnote when a USD figure was actually shown, without clobbering an existing footer. */
function withUsdFootnote(footer: string | undefined, usdShown: boolean): string | undefined {
  if (!usdShown) return footer;
  const note = "USD is a live estimate, not exact.";
  return footer ? `${footer} · ${note}` : note;
}

export interface StatusInfo {
  dryRun: boolean;
  hasOpenSeaKey: boolean;
  watchlistCount: number;
  discordWebhookEnabled: boolean;
  nextTrendCheckAt: Date | null;
  pollIntervalSeconds: number;
  trendAlertTimes: string;
  uptimeSeconds: number;
  /** ISO timestamp the last poll cycle finished, or null if none has completed yet. */
  lastPollAt: string | null;
  /** ISO timestamp the last twice-daily trend/floor-move check ran, or null if none has fired yet. */
  lastTrendCheckAt: string | null;
  rateLimitHealth: RateLimitHealth;
  /** Per-collection activity since the process started — resets on restart, same as everything else in-memory here. */
  activitySummary: Array<{ label: string; listings: number; sales: number; leads: number }>;
  /** Group 3 surfaces. */
  watchedItemCount: number;
  whaleCount: number;
  lastRecapAt: string | null;
  nextRecapAt: Date | null;
  chartsEnabled: boolean;
  /** Resolved read-only portfolio address, or null when unresolved/unconfigured. */
  portfolioAddress: string | null;
  portfolioEnsName: string | null;
}

/** "2h 14m", "45m", "38s" — never a raw seconds count. */
function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** "5m ago", "just now", "never". */
function relativeTimeOrNever(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 30) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h ago`;
}

/** "🟢 18% below floor" / "🔴 5% above floor" / "at floor" — a friendlier read than a raw signed percentage. */
function floorDeltaTag(percentFromFloor: number): string {
  if (percentFromFloor === 0) return "at floor";
  return percentFromFloor < 0 ? `🟢 ${Math.abs(percentFromFloor)}% below floor` : `🔴 ${percentFromFloor}% above floor`;
}

/**
 * OpenSea item page (always buildable, no API call), Etherscan for the
 * contract and the specific token, and the seller's wallet if we have one.
 * Assumes Ethereum mainnet, same as the rest of this project (CHAIN_NAME
 * defaults to "ethereum" and there's no multi-chain support elsewhere).
 * Degrades gracefully — a missing tokenId/contract just narrows the set of
 * links produced instead of erroring.
 */
function buildQuickLinks(collectionId: string, tokenId: string, sellerWallet?: string): string {
  const links = [
    `[OpenSea](https://opensea.io/assets/ethereum/${collectionId}/${tokenId})`,
    `[Etherscan: item](https://etherscan.io/nft/${collectionId}/${tokenId})`,
    `[Etherscan: contract](https://etherscan.io/address/${collectionId})`,
  ];
  if (sellerWallet) links.push(`[Etherscan: seller](https://etherscan.io/address/${sellerWallet})`);
  return links.join(" · ");
}

export function buildBidLeadEmbed(candidate: BidLeadCandidate, match: WatchlistMatch): EmbedContent {
  const fields: EmbedFieldContent[] = [
    { name: "Price", value: formatPriceWithUsd(candidate.priceNative, candidate.priceCurrency, { ethUsdRate: candidate.ethUsdRate }), inline: true },
    { name: "Floor", value: formatPriceWithUsd(candidate.floorPriceNative, candidate.priceCurrency, { ethUsdRate: candidate.ethUsdRate }), inline: true },
    { name: "vs floor", value: floorDeltaTag(candidate.percentFromFloor), inline: true },
  ];

  if (candidate.lastSalePriceNative !== undefined && candidate.lastSalePriceCurrency !== undefined) {
    fields.push({
      name: "Last sale",
      value: formatPriceWithUsd(candidate.lastSalePriceNative, candidate.lastSalePriceCurrency, { ethUsdRate: candidate.ethUsdRate }),
      inline: true,
    });
  }
  if (candidate.trait) {
    fields.push({ name: "Trait", value: `${candidate.trait.key}: ${candidate.trait.value}`, inline: true });
  }
  if (candidate.rankPercentile !== undefined) {
    const rankText = candidate.rank !== undefined ? `#${candidate.rank} (top ${candidate.rankPercentile.toFixed(1)}%)` : `top ${candidate.rankPercentile.toFixed(1)}%`;
    fields.push({ name: "Rarity", value: rankText, inline: true });
  }
  fields.push({ name: "Source", value: candidate.source, inline: true });
  fields.push({ name: "Watchlist entry", value: `${match.entry.label} (${match.entry.priorityTier})`, inline: false });
  fields.push({ name: "Links", value: buildQuickLinks(candidate.collectionId, candidate.tokenId, candidate.sellerWallet), inline: false });

  return {
    title: `Bid lead — ${candidate.collectionName} #${candidate.tokenId}`,
    description: match.reasoning.map((r) => `• ${r}`).join("\n"),
    color: COLOR_LEAD,
    fields,
    footer: withUsdFootnote(`Listing ${candidate.listingId} • Use the buttons below (or react ✅❌👀)`, candidate.ethUsdRate !== undefined),
    image: candidate.imageUrl,
  };
}

export function buildDryRunResultEmbed(result: DryRunResult): EmbedContent {
  return {
    title: `Dry-run ${result.action} order`,
    description: result.summary,
    color: COLOR_ACCEPT,
    fields: [
      { name: "Estimated gas", value: `${result.estimatedGasUnits} units (~${result.estimatedGasCostNative} ${result.gasCurrency})`, inline: true },
      { name: "Would submit to", value: result.wouldSubmitTo, inline: false },
    ],
    footer: "DRY-RUN ONLY — nothing was signed or broadcast.",
  };
}

export function buildAlertEmbed(alert: Alert): EmbedContent {
  return {
    title: alert.title,
    description: alert.message,
    color: alert.severity === "warning" ? COLOR_WARN : COLOR_INFO,
    fields: alert.data ? Object.entries(alert.data).map(([name, value]) => ({ name, value: String(value), inline: true })) : [],
    image: alert.imageUrl,
    thumbnail: alert.thumbnailUrl,
    timestamp: alert.timestamp,
  };
}

/**
 * /watchlist add's confirmation preview — shown BEFORE anything is written
 * to watchlist.json, with Confirm/Cancel buttons attached by the caller
 * (client.ts; buttons aren't part of this framework-agnostic EmbedContent).
 */
export function buildAddPreviewEmbed(
  resolved: ResolvedCollection,
  floor: CollectionInfo | null,
  thumbnail?: string,
  ethUsdRate?: number,
  trait?: Trait,
): EmbedContent {
  const fields: EmbedFieldContent[] = [
    { name: "Slug", value: resolved.slug, inline: true },
    { name: "Address", value: resolved.address, inline: true },
  ];
  if (trait) {
    fields.push({ name: "Trait scope", value: `**${trait.key}: ${trait.value}**`, inline: true });
  }
  if (floor) {
    fields.push({ name: "Floor", value: formatPriceWithUsd(floor.floorPriceNative, floor.floorPriceCurrency, { ethUsdRate }), inline: true });
    if (floor.owners !== undefined) fields.push({ name: "Owners", value: String(floor.owners), inline: true });
    if (floor.volume24hNative !== undefined) {
      fields.push({ name: "24h volume", value: formatPriceWithUsd(floor.volume24hNative, floor.floorPriceCurrency, { ethUsdRate }), inline: true });
    }
  } else {
    fields.push({ name: "Floor", value: "unavailable", inline: true });
  }

  return {
    title: `Add to watchlist? — ${resolved.name}${trait ? ` (${trait.key}: ${trait.value})` : ""}`,
    description: trait
      ? `Review the details below, then confirm or cancel — nothing is added until you do.\n` +
        `**Scoped to \`${trait.key}: ${trait.value}\`** — only items carrying this trait will produce leads, listings, or alerts for this entry.`
      : "Review the details below, then confirm or cancel — nothing is added until you do.",
    color: COLOR_LEAD,
    fields,
    thumbnail,
    footer: withUsdFootnote("Only you can confirm or cancel this.", ethUsdRate !== undefined && floor !== null),
  };
}

export function buildFloorEmbed(collectionId: string, floor: CollectionInfo, ethUsdRate?: number): EmbedContent {
  const fields: EmbedFieldContent[] = [
    { name: "Floor", value: formatPriceWithUsd(floor.floorPriceNative, floor.floorPriceCurrency, { ethUsdRate }), inline: true },
  ];
  if (floor.volume24hNative !== undefined) {
    fields.push({ name: "24h volume", value: formatPriceWithUsd(floor.volume24hNative, floor.floorPriceCurrency, { ethUsdRate }), inline: true });
  }
  if (floor.owners !== undefined) fields.push({ name: "Owners", value: String(floor.owners), inline: true });
  if (floor.listingsCount !== undefined) fields.push({ name: "Listings", value: String(floor.listingsCount), inline: true });
  fields.push({ name: "Contract", value: collectionId, inline: false });

  return {
    title: `Floor — ${floor.name}`,
    color: COLOR_INFO,
    fields,
    footer: withUsdFootnote(undefined, ethUsdRate !== undefined),
  };
}

export function buildListingsEmbed(collectionName: string, hours: number, listings: ListingInfo[], ethUsdRate?: number): EmbedContent {
  if (listings.length === 0) {
    return {
      title: `Recent listings — ${collectionName}`,
      description: `No listings found in the past ${hours}h.`,
      color: COLOR_NEUTRAL,
      fields: [],
    };
  }

  const fields: EmbedFieldContent[] = listings.slice(0, 20).map((l) => ({
    name: `#${l.tokenId} — ${formatPriceWithUsd(l.priceNative, l.priceCurrency, { ethUsdRate })}`,
    value: `${ageLabel(l.createdAt)} • ${l.source} • seller ${shortAddress(l.seller)}`,
    inline: false,
  }));

  return {
    title: `Recent listings — ${collectionName} (past ${hours}h)`,
    description: `${listings.length} listing${listings.length === 1 ? "" : "s"} found.`,
    color: COLOR_INFO,
    fields,
    footer: withUsdFootnote(listings.length > 20 ? `Showing 20 of ${listings.length}` : undefined, ethUsdRate !== undefined),
  };
}

export function buildOffersEmbed(
  collectionName: string,
  offers: CollectionOfferInfo[],
  collectionThumbnail?: string,
  ethUsdRate?: number,
): EmbedContent {
  if (offers.length === 0) {
    return {
      title: `Top offers — ${collectionName}`,
      description: "No active offers found.",
      color: COLOR_NEUTRAL,
      fields: [],
      thumbnail: collectionThumbnail,
    };
  }

  const topCollectionOffer = offers
    .filter((o) => o.scope === "collection")
    .reduce<CollectionOfferInfo | undefined>((top, o) => (!top || o.priceNative > top.priceNative ? o : top), undefined);

  const fields: EmbedFieldContent[] = offers.slice(0, 20).map((o) => ({
    name: `${formatPriceWithUsd(o.priceNative, o.priceCurrency, { ethUsdRate })} — ${scopeLabel(o)}`,
    value: `${ageLabel(o.createdAt)} • bidder ${shortAddress(o.bidder)}`,
    inline: false,
  }));

  return {
    title: `Top offers — ${collectionName}`,
    description: topCollectionOffer
      ? `**Top collection offer:** ${formatPriceWithUsd(topCollectionOffer.priceNative, topCollectionOffer.priceCurrency, { ethUsdRate })}`
      : undefined,
    color: COLOR_INFO,
    fields,
    thumbnail: collectionThumbnail,
    footer: withUsdFootnote(undefined, ethUsdRate !== undefined),
  };
}

function scopeLabel(o: CollectionOfferInfo): string {
  if (o.scope === "trait" && o.trait) return `trait ${o.trait.key}: ${o.trait.value}`;
  if (o.scope === "token") return "single token";
  return "collection-wide";
}

export function buildSaleEmbed(sale: SaleInfo, collectionName: string, ethUsdRate?: number): EmbedContent {
  const priceText = formatPriceWithUsd(sale.priceNative, sale.priceCurrency, { knownUsd: sale.priceUsd, ethUsdRate });
  const usdShown = sale.priceUsd !== undefined || ethUsdRate !== undefined;
  const links = [buildQuickLinks(sale.collectionId, sale.tokenId, sale.seller), `[Etherscan: tx](https://etherscan.io/tx/${sale.transactionHash})`].join(
    " · ",
  );

  return {
    title: `Sale — ${collectionName} #${sale.tokenId}`,
    description: `Sold for ${priceText}, ${ageLabel(sale.createdAt)}.`,
    color: COLOR_INFO,
    fields: [
      { name: "Price", value: priceText, inline: true },
      { name: "Buyer", value: shortAddress(sale.buyer), inline: true },
      { name: "Seller", value: shortAddress(sale.seller), inline: true },
      { name: "Marketplace", value: sale.source, inline: true },
      { name: "Links", value: links, inline: false },
    ],
    footer: withUsdFootnote(`Tx ${sale.transactionHash}`, usdShown),
    image: sale.imageUrl,
  };
}

/**
 * The single living "still listed" status message threaded onto a
 * #new-listings anchor — built fresh each recurrence, but the CALLER
 * (client.ts) edits an existing Discord message with this content instead
 * of posting a new one, so the thread holds one updating line (with the
 * NFT image) per active listing rather than accumulating a message per
 * poll.
 */
export function buildListingStatusEmbed(params: {
  collectionName: string;
  tokenId: string;
  priceNative: number;
  priceCurrency: string;
  imageUrl?: string;
  seenCount: number;
  lastSeenAt: string;
  ethUsdRate?: number;
}): EmbedContent {
  const lastSeenUnix = Math.floor(new Date(params.lastSeenAt).getTime() / 1000);
  return {
    title: `🔁 Still listed — ${params.collectionName} #${params.tokenId}`,
    description: `@ ${formatPriceWithUsd(params.priceNative, params.priceCurrency, { ethUsdRate: params.ethUsdRate })} · last seen <t:${lastSeenUnix}:R> · seen ${params.seenCount}×`,
    color: COLOR_NEUTRAL,
    fields: [],
    image: params.imageUrl,
  };
}

export function buildWatchlistEmbed(entries: AllowlistEntry[]): EmbedContent {
  if (entries.length === 0) {
    return {
      title: "Watchlist",
      description: "Nothing on the watchlist yet — use `/watchlist add` to add a collection.",
      color: COLOR_NEUTRAL,
      fields: [],
    };
  }

  const fields: EmbedFieldContent[] = entries.map((e) => {
    const filterSummary = summarizeFilters(e);
    return {
      name: `${e.enabled ? "✅" : "⏸️"} ${e.label} (${e.priorityTier})`,
      value: `\`${e.collection}\`${filterSummary ? `\n${filterSummary}` : ""}`,
      inline: false,
    };
  });

  return {
    title: `Watchlist (${entries.length})`,
    color: COLOR_INFO,
    fields,
  };
}

function summarizeFilters(e: AllowlistEntry): string {
  const parts: string[] = [];
  if (e.filters.priceBand?.targetBuyPrice !== undefined) parts.push(`target ≤${e.filters.priceBand.targetBuyPrice}`);
  if (e.filters.bidSpread) parts.push(`spread ${e.filters.bidSpread.minPercentFromFloor ?? "-∞"}%..${e.filters.bidSpread.maxPercentFromFloor ?? "+∞"}%`);
  if (e.filters.trend?.minFloorMovePercent !== undefined) parts.push(`trend ≥${e.filters.trend.minFloorMovePercent}%`);
  if (e.muted) parts.push("muted");
  return parts.join(" · ");
}

export function buildStatusEmbed(status: StatusInfo): EmbedContent {
  const fields: EmbedFieldContent[] = [
    { name: "Mode", value: status.dryRun ? "DRY-RUN" : "LIVE (unsupported)", inline: true },
    { name: "Data source", value: status.hasOpenSeaKey ? "OpenSea live API" : "mock data", inline: true },
    { name: "Uptime", value: formatUptime(status.uptimeSeconds), inline: true },
    { name: "Watchlist", value: `${status.watchlistCount} collection(s)`, inline: true },
    { name: "Discord webhook", value: status.discordWebhookEnabled ? "enabled" : "disabled", inline: true },
    { name: "Poll interval", value: `${status.pollIntervalSeconds}s (bid leads / new listings)`, inline: true },
    { name: "Last poll", value: relativeTimeOrNever(status.lastPollAt), inline: true },
    { name: "Last trend check", value: relativeTimeOrNever(status.lastTrendCheckAt), inline: true },
    { name: "Trend digest times", value: status.trendAlertTimes, inline: true },
    {
      name: "Next trend digest",
      value: `${status.nextTrendCheckAt ? status.nextTrendCheckAt.toLocaleString() : "not scheduled"}${status.chartsEnabled ? " (with chart)" : ""}`,
      inline: false,
    },
    { name: "👀 Watching", value: `${status.watchedItemCount} item(s)`, inline: true },
    { name: "🐋 Tracked wallets", value: `${status.whaleCount}`, inline: true },
    { name: "Last recap", value: relativeTimeOrNever(status.lastRecapAt), inline: true },
    {
      name: "Next daily recap",
      value: status.nextRecapAt ? status.nextRecapAt.toLocaleString() : "not scheduled",
      inline: false,
    },
    {
      name: "📦 Portfolio (read-only)",
      value: status.portfolioAddress
        ? `${status.portfolioEnsName ? `${status.portfolioEnsName} → ` : ""}\`${status.portfolioAddress}\`\nPublic address only — no key, cannot sign or spend.`
        : "not resolved (set PORTFOLIO_ENS_NAME or PORTFOLIO_ADDRESS)",
      inline: false,
    },
    {
      name: "OpenSea rate limit",
      value: `${status.rateLimitHealth.requestsInLastMinute}/${status.rateLimitHealth.budgetPerMinute} req/min · queue ${status.rateLimitHealth.queueLength} · ${status.rateLimitHealth.recent429Count} recent 429${status.rateLimitHealth.recent429Count === 1 ? "" : "s"}${status.rateLimitHealth.last429At ? ` (last ${relativeTimeOrNever(status.rateLimitHealth.last429At)})` : ""}`,
      inline: false,
    },
  ];

  if (status.activitySummary.length > 0) {
    const lines = status.activitySummary.map((a) => `**${a.label}** — ${a.listings} listing${a.listings === 1 ? "" : "s"}, ${a.sales} sale${a.sales === 1 ? "" : "s"}, ${a.leads} lead${a.leads === 1 ? "" : "s"}`);
    fields.push({ name: `Activity since startup`, value: lines.join("\n").slice(0, 1024), inline: false });
  }

  return {
    title: "Orc Butler status",
    color: status.dryRun ? COLOR_ACCEPT : COLOR_WARN,
    fields,
  };
}

export function buildHelpEmbed(): EmbedContent {
  return {
    title: "Orc Butler commands",
    color: COLOR_INFO,
    fields: [
      {
        name: "/watchlist add collection:<...> [trait_category:] [trait_value:]",
        value:
          "Preview a collection (name/floor/image/owners), then Confirm/Cancel before it's added. " +
          "**Optionally scope it to one trait** — supply `trait_category` + `trait_value` and only items carrying that trait will produce leads, " +
          "listings, or alerts for the entry. Both are autocompleted from the collection's real trait catalog, and a trait that isn't in the " +
          "collection is rejected. Omit them to watch the whole collection. The same collection can be added more than once under different traits.\n" +
          "Collection autocomplete suggests watchlist entries + live OpenSea matches as you type, but search coverage is uneven for small/new " +
          "collections — if it doesn't show up, use the exact slug from its opensea.io/collection/<slug> URL, or its 0x contract address.",
        inline: false,
      },
      { name: "/watchlist remove collection:<name|slug|address>", value: "Remove a collection from the allowlist.", inline: false },
      { name: "/watchlist list", value: "Show every allowlist entry.", inline: false },
      {
        name: "/watchlist create-rule collection: condition: ...",
        value:
          "Guided lead rule: pick a collection and ONE condition — price below X ETH, top X% rarity, a specific trait listed, or a trait floor. " +
          "Trait category/value are autocompleted from the collection's real trait data once you've picked a collection.",
        inline: false,
      },
      { name: "/listings collection:<...> hours:<int>", value: "Recent listings within the past N hours (default 24).", inline: false },
      { name: "/floor collection:<...>", value: "Current floor price and stats.", inline: false },
      { name: "/offers collection:<...>", value: "Current top offers/bids.", inline: false },
      {
        name: "/watching list · /watching remove collection: token_id:",
        value:
          "Items you've marked 👀. Each one keeps generating follow-up alerts — **price drop/change**, **sold**, and **likely delisted** — and the list survives restarts.",
        inline: false,
      },
      {
        name: "/whale add address:<0x…> label:<...> · /whale remove · /whale list",
        value:
          "Track wallets. Alerts fire when a tracked wallet **buys, sells, or lists inside an allowlisted collection** — activity anywhere else is never reported. Deduped and rate-limited like every other signal.",
        inline: false,
      },
      {
        name: "/config show · /config set key: value: · /config reset key: · /config entry collection: key: value:",
        value:
          "Edit tunables live from Discord — thresholds, quiet hours, mute, rule values, USD toggle. Changes are validated, persisted to watchlist.json, and take effect immediately. `/config reset` drops an override back to the .env value.",
        inline: false,
      },
      {
        name: "/portfolio",
        value:
          "**READ-ONLY** holdings for the configured public address (resolved from ENS), their floor value, and offers received. " +
          "The bot holds no private key, makes no wallet connection, and cannot sign or spend anything.",
        inline: false,
      },
      {
        name: "/status",
        value:
          "Full dashboard: mode, data source, uptime, last poll/trend-check, OpenSea rate-limit health, next trend digest and daily recap, " +
          "watched-item and tracked-wallet counts, the read-only portfolio address, and per-collection activity counts since the bot started.",
        inline: false,
      },
      {
        name: "Digests",
        value:
          "**Trend digest** (twice daily) posts floor moves past the threshold, each with a locally-rendered floor/volume chart. " +
          "**Overnight recap** (once daily) summarizes the past 24h across every watched collection.",
        inline: false,
      },
      {
        name: "💰 #highest-offers",
        value:
          "Fires when a watched collection's top offer sets a **new record high**, tracked separately per offer kind:\n" +
          "🎯 **Item** (one specific token — shows that item's image + #tokenId) · " +
          "🏷️ **Trait** (any item with a given trait — shows the collection image + the trait, each trait its own record) · " +
          "🌐 **Collection** (any item — collection image).\n" +
          "Each post names the scope and the delta vs. that scope's own previous high. Not a feed of every offer: standing offers never " +
          "repost, and every scope is baselined silently on first run so restarts don't replay it.",
        inline: false,
      },
      {
        name: "Bid-lead cards (#bid-leads)",
        value:
          "Accept/Deny/Watch buttons (or react ✅❌👀) — Accept shows a Confirm/Cancel step first (builds a DRY-RUN order only, nothing is signed). " +
          "The card updates in place to show ✅ ACCEPTED / ❌ DENIED / 👀 WATCHING once decided.",
        inline: false,
      },
      { name: "/help", value: "This message.", inline: false },
    ],
    footer: "Only the authorized user can use these commands. All replies are private (ephemeral).",
  };
}

// --- Group 3: watch flow, whales, recap, config, portfolio ---

/** 👀 A watched token's price moved, it sold, or it looks delisted. */
export function buildWatchedSoldEmbed(item: WatchedItem, sale: SaleInfo, ethUsdRate?: number): EmbedContent {
  const priceText = formatPriceWithUsd(sale.priceNative, sale.priceCurrency, { knownUsd: sale.priceUsd, ethUsdRate });
  const watchedAtText = formatPriceWithUsd(item.lastKnownPriceNative, item.lastKnownPriceCurrency, { ethUsdRate });
  const delta = sale.priceNative - item.lastKnownPriceNative;
  const deltaText =
    item.lastKnownPriceNative > 0
      ? `${delta >= 0 ? "▲" : "▼"} ${Math.abs((delta / item.lastKnownPriceNative) * 100).toFixed(1)}% vs. when you started watching`
      : "—";

  return {
    title: `💸 Watched item SOLD — ${item.collectionName} #${item.tokenId}`,
    description: `You were watching this at ${watchedAtText}. It just sold for **${priceText}**.`,
    color: COLOR_WARN,
    fields: [
      { name: "Sold for", value: priceText, inline: true },
      { name: "You watched at", value: watchedAtText, inline: true },
      { name: "Change", value: deltaText, inline: true },
      { name: "Buyer", value: shortAddress(sale.buyer), inline: true },
      { name: "Seller", value: shortAddress(sale.seller), inline: true },
      { name: "Links", value: buildQuickLinks(item.collectionId, item.tokenId), inline: false },
    ],
    footer: withUsdFootnote("No longer watching — it's gone.", ethUsdRate !== undefined || sale.priceUsd !== undefined),
    image: sale.imageUrl,
    timestamp: sale.createdAt,
  };
}

export function buildWatchedDelistedEmbed(item: WatchedItem, ethUsdRate?: number): EmbedContent {
  return {
    title: `🚪 Watched item likely DELISTED — ${item.collectionName} #${item.tokenId}`,
    description:
      `It hasn't appeared in recent listings or sales for several consecutive polls, so it looks like the listing was pulled. ` +
      `This is a best-effort signal — the data we poll is a capped recent-activity window, not a full live snapshot, so treat it as a hint rather than a fact.`,
    color: COLOR_NEUTRAL,
    fields: [
      { name: "Last known price", value: formatPriceWithUsd(item.lastKnownPriceNative, item.lastKnownPriceCurrency, { ethUsdRate }), inline: true },
      { name: "Watched since", value: `<t:${Math.floor(new Date(item.addedAt).getTime() / 1000)}:R>`, inline: true },
      { name: "Links", value: buildQuickLinks(item.collectionId, item.tokenId), inline: false },
    ],
    footer: withUsdFootnote("No longer watching.", ethUsdRate !== undefined),
  };
}

/** `/watching list` */
export function buildWatchingEmbed(items: WatchedItem[], ethUsdRate?: number): EmbedContent {
  if (items.length === 0) {
    return {
      title: "Watching",
      description: "Nothing is being watched. React 👀 (or press **Watch**) on a bid-lead card to start watching an item.",
      color: COLOR_NEUTRAL,
      fields: [],
    };
  }

  const fields: EmbedFieldContent[] = items.slice(0, 25).map((item) => ({
    name: `${item.collectionName} #${item.tokenId}`,
    value:
      `${formatPriceWithUsd(item.lastKnownPriceNative, item.lastKnownPriceCurrency, { ethUsdRate })} · ` +
      `since <t:${Math.floor(new Date(item.addedAt).getTime() / 1000)}:R>\n` +
      `\`/watching remove collection:${item.collectionId} token_id:${item.tokenId}\``,
    inline: false,
  }));

  return {
    title: `👀 Watching (${items.length})`,
    description: "Follow-up alerts fire on price change, sale, or likely delisting.",
    color: COLOR_WATCHING,
    fields,
    footer: withUsdFootnote(items.length > 25 ? `Showing 25 of ${items.length}` : undefined, ethUsdRate !== undefined),
  };
}

/** A marked wallet bought/sold/listed inside an allowlisted collection. */
export function buildWhaleActivityEmbed(activity: WhaleActivity): EmbedContent {
  const verb = activity.action === "bought" ? "BOUGHT" : activity.action === "sold" ? "SOLD" : "LISTED";
  const emoji = activity.action === "bought" ? "🐋🟢" : activity.action === "sold" ? "🐋🔴" : "🐋🏷️";
  const priceText = formatPriceWithUsd(activity.priceNative, activity.priceCurrency, { ethUsdRate: activity.ethUsdRate });

  const fields: EmbedFieldContent[] = [
    { name: "Wallet", value: `[${activity.wallet.label}](https://etherscan.io/address/${activity.wallet.address})`, inline: true },
    { name: "Action", value: verb, inline: true },
    { name: "Price", value: priceText, inline: true },
  ];
  if (activity.counterparty) fields.push({ name: "Counterparty", value: shortAddress(activity.counterparty), inline: true });

  const links = [buildQuickLinks(activity.collectionId, activity.tokenId, activity.wallet.address)];
  if (activity.transactionHash) links.push(`[Etherscan: tx](https://etherscan.io/tx/${activity.transactionHash})`);
  fields.push({ name: "Links", value: links.join(" · "), inline: false });

  return {
    title: `${emoji} Whale ${verb} — ${activity.collectionName} #${activity.tokenId}`,
    description: `**${activity.wallet.label}** ${activity.action} this for ${priceText}.`,
    color: activity.action === "bought" ? COLOR_ACCEPT : activity.action === "sold" ? COLOR_WARN : COLOR_LEAD,
    fields,
    footer: withUsdFootnote("Tracked wallet · allowlisted collections only", activity.ethUsdRate !== undefined),
    image: activity.imageUrl,
    timestamp: activity.timestamp,
  };
}

/** `/whale list` */
export function buildWhaleListEmbed(wallets: WhaleWallet[]): EmbedContent {
  if (wallets.length === 0) {
    return {
      title: "🐋 Tracked wallets",
      description: "No wallets are being tracked. Add one with `/whale add address:0x… label:…`.",
      color: COLOR_NEUTRAL,
      fields: [],
    };
  }

  return {
    title: `🐋 Tracked wallets (${wallets.length})`,
    description: "Alerts fire when any of these buy, sell, or list **inside an allowlisted collection** — activity elsewhere is never reported.",
    color: COLOR_INFO,
    fields: wallets.slice(0, 25).map((w) => ({
      name: w.label,
      value: `[\`${w.address}\`](https://etherscan.io/address/${w.address})\nsince <t:${Math.floor(new Date(w.addedAt).getTime() / 1000)}:R>`,
      inline: false,
    })),
    footer: wallets.length > 25 ? `Showing 25 of ${wallets.length}` : undefined,
  };
}

/** The once-daily overnight recap. */
export function buildRecapEmbed(summary: RecapSummary): EmbedContent {
  const changeText = (line: RecapCollectionLine): string => {
    if (line.changePct === null) return "floor —"; // not enough history yet, which is different from "no change"
    const arrow = line.changePct > 0 ? "▲" : line.changePct < 0 ? "▼" : "▬";
    return `floor ${arrow} ${Math.abs(line.changePct).toFixed(1)}%`;
  };

  const fields: EmbedFieldContent[] = summary.lines.slice(0, 20).map((line) => ({
    name: line.label,
    value:
      `${changeText(line)} · now ${line.floorNow !== null ? formatPriceWithUsd(line.floorNow, line.currency, { ethUsdRate: summary.ethUsdRate }) : "unknown"}\n` +
      `${line.listings} listing${line.listings === 1 ? "" : "s"} · ${line.sales} sale${line.sales === 1 ? "" : "s"} · ${line.leads} lead${line.leads === 1 ? "" : "s"}` +
      (line.salesVolumeNative > 0 ? ` · ${line.salesVolumeNative} ${line.currency} volume` : ""),
    inline: false,
  }));

  const headline: string[] = [];
  if (summary.topGainer) headline.push(`📈 **${summary.topGainer.label}** +${summary.topGainer.changePct!.toFixed(1)}%`);
  if (summary.topLoser) headline.push(`📉 **${summary.topLoser.label}** ${summary.topLoser.changePct!.toFixed(1)}%`);

  return {
    title: `🌅 Overnight recap — past ${summary.windowHours}h`,
    description:
      (headline.length > 0 ? `${headline.join(" · ")}\n\n` : "") +
      `Across ${summary.lines.length} watched collection${summary.lines.length === 1 ? "" : "s"}: ` +
      `**${summary.totals.listings}** new listing${summary.totals.listings === 1 ? "" : "s"}, ` +
      `**${summary.totals.sales}** sale${summary.totals.sales === 1 ? "" : "s"}, ` +
      `**${summary.totals.leads}** bid lead${summary.totals.leads === 1 ? "" : "s"}.`,
    color: COLOR_LEAD,
    fields,
    footer: withUsdFootnote(
      summary.lines.length > 20 ? `Showing 20 of ${summary.lines.length} collections` : undefined,
      summary.ethUsdRate !== undefined,
    ),
    timestamp: summary.generatedAt,
  };
}

/**
 * A new record-high offer on a watched collection (#highest-offers). Only
 * ever built for a genuine new record — baselines and non-records never
 * reach here (see leadMonitor.checkHighestOffer).
 */
export function buildHighestOfferEmbed(event: HighestOfferEvent): EmbedContent {
  const { record, previous, ethUsdRate } = event;
  const priceText = formatPriceWithUsd(record.priceNative, record.priceCurrency, { ethUsdRate });
  const previousText = formatPriceWithUsd(previous.priceNative, previous.priceCurrency, { ethUsdRate });

  const isItem = record.scope === "token";
  const isTrait = record.scope === "trait";

  // Title states the scope unmistakably — these three are NOT equivalent
  // offers, and reading "new highest offer" without knowing which kind it is
  // would be actively misleading.
  const title = isItem
    ? `🎯 New highest ITEM offer — ${event.collectionName}${record.tokenId ? ` #${record.tokenId}` : ""}`
    : isTrait
      ? `🏷️ New highest TRAIT offer — ${event.collectionName}`
      : `🌐 New highest COLLECTION offer — ${event.collectionName}`;

  const scopeLine = isItem
    ? `Offer on **one specific token**${record.tokenId ? ` (#${record.tokenId})` : ""} — not the whole collection.`
    : isTrait
      ? record.trait
        ? `Trait-exclusive offer: applies to **any item with \`${record.trait.key} = ${record.trait.value}\`** — not the whole collection.`
        : "Trait-exclusive offer: applies to any item carrying the offered trait — not the whole collection."
      : "Collection-wide offer: applies to **any item** in the collection.";

  const pct = previous.priceNative > 0 ? ((record.priceNative - previous.priceNative) / previous.priceNative) * 100 : null;
  const deltaText =
    pct !== null
      ? `▲ **new high ${record.priceNative} ${record.priceCurrency}**, up from ${previous.priceNative} (+${pct.toFixed(1)}%)`
      : `▲ **new high ${record.priceNative} ${record.priceCurrency}**`;

  const scopeValue = isItem
    ? `Item offer${record.tokenId ? ` · #${record.tokenId}` : ""}`
    : isTrait
      ? record.trait
        ? `Trait offer · ${record.trait.key} = ${record.trait.value}`
        : "Trait offer"
      : "Collection offer · any item";

  const links = [
    `[OpenSea](https://opensea.io/assets/ethereum/${event.collectionId})`,
    `[Etherscan: offerer](https://etherscan.io/address/${record.bidder})`,
  ];
  if (record.tokenId) links.unshift(`[Item](https://opensea.io/assets/ethereum/${event.collectionId}/${record.tokenId})`);

  return {
    title,
    description: `${deltaText}\n${scopeLine}`,
    color: COLOR_ACCEPT,
    fields: [
      { name: "Offer", value: priceText, inline: true },
      { name: "Previous high (same scope)", value: previousText, inline: true },
      { name: "Scope", value: scopeValue, inline: true },
      { name: "Offerer", value: shortAddress(record.bidder), inline: true },
      { name: "Links", value: links.join(" · "), inline: false },
    ],
    // Item offers show that token's art; trait and collection offers apply to
    // many items, so the collection image is the only honest illustration.
    image: isItem ? event.itemImageUrl : undefined,
    thumbnail: isItem ? undefined : event.collectionImageUrl,
    footer: withUsdFootnote(
      isItem
        ? "Record high for ITEM offers on this collection."
        : isTrait
          ? "Record high for THIS trait. Tracked separately from collection-wide and item offers."
          : "Record high for COLLECTION-WIDE offers. Tracked separately from trait and item offers.",
      ethUsdRate !== undefined,
    ),
    timestamp: record.recordedAt,
  };
}

/** `/config show` */
export function buildConfigEmbed(settings: Array<{ key: string; value: string; source: "discord" | "env" }>): EmbedContent {
  return {
    title: "⚙️ Configuration",
    description:
      "Global tunables. `discord` = overridden via `/config set` (persisted in watchlist.json); `env` = using the .env value.\n" +
      "Use `/config reset key:<name>` to drop an override and fall back to .env.",
    color: COLOR_INFO,
    fields: settings.map((s) => ({
      name: s.key,
      value: `**${s.value}** · from \`${s.source}\``,
      inline: true,
    })),
    footer: "Per-collection tunables: /config entry collection:<...> key:<...> value:<...>",
  };
}

/**
 * `/portfolio` — READ-ONLY. Every figure here is derived from public data
 * about a public address; the bot holds no key and cannot transact. That's
 * stated in the footer so it's visible at the point of use, not just in the
 * docs.
 */
export function buildPortfolioEmbed(snapshot: PortfolioSnapshot): EmbedContent {
  if (snapshot.holdings.length === 0) {
    return {
      title: `📦 Portfolio — ${snapshot.ensName ?? shortAddress(snapshot.address)}`,
      description:
        `No NFT holdings found for \`${snapshot.address}\`.\n` +
        "If you expected holdings here, note that portfolio lookups need a live `OPENSEA_API_KEY` — the bot will not fabricate a portfolio from mock data.",
      color: COLOR_NEUTRAL,
      fields: [],
      footer: "READ-ONLY · public address · no private key, no wallet connection, cannot sign or spend.",
    };
  }

  const fields: EmbedFieldContent[] = snapshot.holdings.slice(0, 20).map((h) => {
    const value =
      h.estimatedValueNative !== null
        ? `${h.count} item${h.count === 1 ? "" : "s"} × ${formatPriceWithUsd(h.floorNative!, h.floorCurrency, { ethUsdRate: snapshot.ethUsdRate })} = **${formatPriceWithUsd(h.estimatedValueNative, h.floorCurrency, { ethUsdRate: snapshot.ethUsdRate })}**`
        : `${h.count} item${h.count === 1 ? "" : "s"} · floor unavailable`;
    const offer =
      h.topOfferNative !== undefined
        ? `\ntop offer received: ${formatPriceWithUsd(h.topOfferNative, h.topOfferCurrency ?? "ETH", { ethUsdRate: snapshot.ethUsdRate })} (on #${h.topOfferTokenId})`
        : "";
    return { name: h.collectionName, value: `${value}${offer}`, inline: false };
  });

  const caveats: string[] = [];
  if (snapshot.collectionsMissingFloor > 0) {
    caveats.push(`${snapshot.collectionsMissingFloor} collection(s) had no readable floor, so the total is an understatement`);
  }
  if (snapshot.truncated) caveats.push("holdings were truncated at the fetch cap");
  caveats.push(`offers sampled on ${snapshot.offersSampled} token(s), not all`);

  return {
    title: `📦 Portfolio — ${snapshot.ensName ?? shortAddress(snapshot.address)}`,
    description:
      `\`${snapshot.address}\`\n` +
      `**${snapshot.totalItems}** item${snapshot.totalItems === 1 ? "" : "s"} across **${snapshot.holdings.length}** collection${snapshot.holdings.length === 1 ? "" : "s"} · ` +
      `estimated floor value **${formatPriceWithUsd(snapshot.estimatedTotalNative, "ETH", { ethUsdRate: snapshot.ethUsdRate })}**\n` +
      `_${caveats.join("; ")}._`,
    color: COLOR_LEAD,
    fields,
    footer: withUsdFootnote(
      "READ-ONLY · public address · no private key, no wallet connection, cannot sign or spend.",
      snapshot.ethUsdRate !== undefined,
    ),
    timestamp: snapshot.generatedAt,
  };
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function toDiscordEmbed(content: EmbedContent): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(content.title).setColor(content.color);
  if (content.description) embed.setDescription(content.description);
  if (content.fields.length > 0) embed.addFields(content.fields);
  if (content.footer) embed.setFooter({ text: content.footer });
  // Best-effort — an unreachable/missing image URL just makes Discord drop that part of the embed, never breaks it.
  if (content.image) embed.setImage(content.image);
  if (content.thumbnail) embed.setThumbnail(content.thumbnail);
  if (content.timestamp) embed.setTimestamp(new Date(content.timestamp));
  return embed;
}
