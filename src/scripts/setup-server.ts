import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EmbedBuilder, PermissionFlagsBits, REST } from "discord.js";
import { config } from "../config/env.js";

/**
 * One-shot, idempotent Discord server setup: creates #server-guide (and any
 * other missing SOP channels), posts/updates the pinned SOP + commands
 * reference, and applies permission overwrites enforcing "one channel, one
 * job." Safe to re-run — every step checks for existing state first.
 *
 * Deliberately uses discord.js's REST client only, NOT a gateway Client —
 * this needs no persistent connection, so it never touches or interferes
 * with the main bot process's existing gateway session. Run with:
 *   npm run setup-server
 */

const SOP_TITLE = "Orc Butler — Channel SOP (One channel, one job)";
const COMMANDS_TITLE = "Orc Butler — Commands & Tools Reference";

const CATEGORY_INFORMATION = "Information";
const CATEGORY_AUTOMATION = "Automation";
const CATEGORY_NOTIFICATIONS = "Notifications";

interface DiscordUser {
  id: string;
  username: string;
}

interface DiscordGuildSummary {
  id: string;
  name: string;
}

interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  parent_id?: string | null;
}

interface DiscordEmbed {
  title?: string;
}

interface DiscordMessage {
  id: string;
  author?: { id?: string };
  embeds?: DiscordEmbed[];
}

const CHANNEL_TYPE_GUILD_TEXT = 0;
const CHANNEL_TYPE_GUILD_CATEGORY = 4;
const OVERWRITE_TYPE_ROLE = 0;
const OVERWRITE_TYPE_MEMBER = 1;

interface OpResult {
  ok: boolean;
  detail: string;
}

const results: { step: string; result: OpResult }[] = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, result: { ok, detail } });
  console.log(`${ok ? "✅" : "❌"} ${step}: ${detail}`);
}

async function main(): Promise<void> {
  if (!config.DISCORD_BOT_TOKEN) {
    console.error("DISCORD_BOT_TOKEN is not set — cannot run server setup.");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);

  const me = (await rest.get("/users/@me")) as DiscordUser;
  console.log(`Authenticated as ${me.username} (${me.id}).`);

  const guild = await resolveTargetGuild(rest);
  console.log(`Target guild: ${guild.name} (${guild.id}).`);

  let channels = (await rest.get(`/guilds/${guild.id}/channels`)) as DiscordChannel[];

  const infoCategory = await ensureCategory(rest, guild.id, channels, CATEGORY_INFORMATION);
  const autoCategory = await ensureCategory(rest, guild.id, channels, CATEGORY_AUTOMATION);
  const notifCategory = await ensureCategory(rest, guild.id, channels, CATEGORY_NOTIFICATIONS);
  channels = (await rest.get(`/guilds/${guild.id}/channels`)) as DiscordChannel[];

  const serverGuide = await ensureTextChannel(rest, guild.id, channels, "server-guide", infoCategory.id, "SOP — how this server's channels work.");
  const howItWorks = await ensureTextChannel(rest, guild.id, channels, "how-it-works", infoCategory.id, "Commands & tools reference.");
  const welcome = await ensureTextChannel(rest, guild.id, channels, "welcome", infoCategory.id, "Start here — see #server-guide for the full SOP.");
  const butlerCommands = await ensureTextChannel(rest, guild.id, channels, "butler-commands", autoCategory.id, "Run slash commands here.");
  const butlerStatus = await ensureTextChannel(rest, guild.id, channels, "butler-status", infoCategory.id, "Bot health board (bot-only).");
  const watchlistSales = await ensureTextChannel(
    rest,
    guild.id,
    channels,
    "watchlist-sales",
    notifCategory.id,
    "Recent sales for your watched collections — bot-only feed.",
  );
  channels = (await rest.get(`/guilds/${guild.id}/channels`)) as DiscordChannel[];

  ensureEnvVar("DISCORD_SALES_CHANNEL_ID", watchlistSales.id, true);
  ensureEnvVar("DISCORD_STATUS_CHANNEL_ID", butlerStatus.id, true);

  const bidLeads = requireExistingChannel(channels, config.DISCORD_BID_LEADS_CHANNEL_ID, "bid-leads");
  const newListings = requireExistingChannel(channels, config.DISCORD_NEW_LISTINGS_CHANNEL_ID, "new-listings");
  const trendAlerts = requireExistingChannel(channels, config.DISCORD_TREND_ALERTS_CHANNEL_ID, "trend-alerts");
  const orderLog = requireExistingChannel(channels, config.DISCORD_ORDER_LOG_CHANNEL_ID, "order-log");
  const auditLog = requireExistingChannel(channels, config.DISCORD_AUDIT_LOG_CHANNEL_ID, "audit-log");
  const general = channels.find((c) => c.type === CHANNEL_TYPE_GUILD_TEXT && c.name?.toLowerCase() === "general") ?? null;

  // --- Part C: permission overwrites (BEFORE posting content) ---
  // Channel-level overwrites take precedence over category-inherited ones,
  // so applying the bot's explicit "allow Send Messages" here first is what
  // guarantees the posts below succeed even if a parent category has a
  // restrictive overwrite the bot would otherwise inherit.
  const readOnlyChannels = [welcome, howItWorks, serverGuide, butlerStatus, newListings, trendAlerts, orderLog, auditLog, watchlistSales].filter(
    (c): c is DiscordChannel => c !== null,
  );
  for (const channel of readOnlyChannels) {
    await lockToReadOnly(rest, guild.id, me.id, channel);
  }

  if (bidLeads) await lockBidLeads(rest, guild.id, me.id, bidLeads);
  if (butlerCommands) await lockCommandsChannel(rest, guild.id, me.id, butlerCommands);
  if (general) await openGeneral(rest, guild.id, general);
  else record("#general", true, "not found — nothing to do (create it manually if you want it, no action needed)");

  // Discord's permission-overwrite changes can take a moment to propagate;
  // posting immediately after can transiently 403 even though the change
  // already succeeded. A short settle delay plus the retry inside
  // ensurePinnedMessage below makes this reliable without a fixed guess.
  await sleep(2000);

  // --- Part A: post + pin the SOP in #server-guide ---
  await ensurePinnedMessage(rest, me.id, serverGuide.id, SOP_TITLE, buildSopEmbeds());

  // --- Part B: post + pin the commands reference in #how-it-works ---
  await ensurePinnedMessage(rest, me.id, howItWorks.id, COMMANDS_TITLE, buildCommandsEmbeds());

  // --- Verification: prove the bot can still post after the lockdown ---
  if (butlerStatus) {
    try {
      await rest.post(`/channels/${butlerStatus.id}/messages`, {
        body: {
          embeds: [
            new EmbedBuilder()
              .setTitle("🔧 Server setup complete")
              .setDescription(
                "Channel structure + SOP applied. Permission lockdown verified — this message proves the bot can still post after the change.",
              )
              .setColor(0x67c23a)
              .setTimestamp(new Date())
              .toJSON(),
          ],
        },
      });
      record("Post-lockdown verification", true, "Posted a fresh message to #butler-status — bot can still send.");
    } catch (err) {
      record("Post-lockdown verification", false, `FAILED to post to #butler-status after lockdown: ${(err as Error).message}`);
    }
  }

  const failures = results.filter((r) => !r.result.ok);
  console.log("\n=== Summary ===");
  console.log(`${results.length - failures.length}/${results.length} steps succeeded.`);
  if (failures.length > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f.step}: ${f.result.detail}`);
    process.exitCode = 1;
  }
}

async function resolveTargetGuild(rest: REST): Promise<DiscordGuildSummary> {
  const guilds = (await rest.get("/users/@me/guilds")) as DiscordGuildSummary[];

  if (config.DISCORD_GUILD_ID) {
    const match = guilds.find((g) => g.id === config.DISCORD_GUILD_ID);
    if (!match) throw new Error(`DISCORD_GUILD_ID=${config.DISCORD_GUILD_ID} does not match any guild this bot is currently in.`);
    return match;
  }
  if (guilds.length === 1) return guilds[0]!;
  if (guilds.length === 0) throw new Error("Bot isn't in any guild.");
  throw new Error(`Bot is in ${guilds.length} guilds — set DISCORD_GUILD_ID in .env to pick which one this script should modify.`);
}

async function ensureCategory(rest: REST, guildId: string, channels: DiscordChannel[], name: string): Promise<DiscordChannel> {
  const existing = channels.find((c) => c.type === CHANNEL_TYPE_GUILD_CATEGORY && c.name?.toLowerCase() === name.toLowerCase());
  if (existing) {
    record(`Category "${name}"`, true, "already exists, reusing.");
    return existing;
  }
  try {
    const created = (await rest.post(`/guilds/${guildId}/channels`, { body: { name, type: CHANNEL_TYPE_GUILD_CATEGORY } })) as DiscordChannel;
    record(`Category "${name}"`, true, `created (${created.id}).`);
    return created;
  } catch (err) {
    record(`Category "${name}"`, false, `failed to create: ${(err as Error).message}`);
    throw err;
  }
}

async function ensureTextChannel(
  rest: REST,
  guildId: string,
  channels: DiscordChannel[],
  name: string,
  parentId: string,
  topic: string,
): Promise<DiscordChannel> {
  const existing = channels.find((c) => c.type === CHANNEL_TYPE_GUILD_TEXT && c.name?.toLowerCase() === name.toLowerCase());
  if (existing) {
    const note = existing.parent_id === parentId ? "already exists, reusing." : "already exists (in a different category — left as-is), reusing.";
    record(`#${name}`, true, note);
    return existing;
  }
  try {
    const created = (await rest.post(`/guilds/${guildId}/channels`, {
      body: { name, type: CHANNEL_TYPE_GUILD_TEXT, parent_id: parentId, topic },
    })) as DiscordChannel;
    record(`#${name}`, true, `created (${created.id}).`);
    return created;
  } catch (err) {
    record(`#${name}`, false, `failed to create: ${(err as Error).message}`);
    throw err;
  }
}

function requireExistingChannel(channels: DiscordChannel[], configuredId: string, label: string): DiscordChannel | null {
  if (!configuredId) {
    record(`#${label}`, false, `no ID configured in .env — skipping permissions for this channel.`);
    return null;
  }
  const found = channels.find((c) => c.id === configuredId);
  if (!found) {
    record(`#${label}`, false, `configured ID ${configuredId} not found in this guild — skipping permissions for this channel.`);
    return null;
  }
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ENV_PATH = resolve(process.cwd(), ".env");

/**
 * Idempotently writes `KEY=value` into .env: leaves an existing non-empty
 * value alone (never clobbers something you set by hand), fills in an
 * existing-but-empty `KEY=` line, or appends a new line if the key isn't
 * present at all. Used to persist the #watchlist-sales channel ID this
 * script creates, so re-running the bot picks it up without a manual copy.
 */
/**
 * `force` should be true only for values this script itself derives by
 * resolving a channel by NAME (so .env is just a cache of that lookup, not
 * user-set arbitrary config) — e.g. a channel that got deleted and
 * recreated under a new ID. Without force, a differing existing value is
 * left alone rather than silently overwritten.
 */
function ensureEnvVar(key: string, value: string, force = false): void {
  if (!existsSync(ENV_PATH)) {
    record(`.env: ${key}`, false, `.env not found at ${ENV_PATH} — set ${key}=${value} manually.`);
    return;
  }

  const content = readFileSync(ENV_PATH, "utf8");
  const lineRegex = new RegExp(`^${key}=.*$`, "m");
  const match = content.match(lineRegex);

  if (match) {
    const existingValue = match[0].slice(key.length + 1).trim();
    if (existingValue === value) {
      record(`.env: ${key}`, true, "already set to the correct value.");
      return;
    }
    if (existingValue.length > 0 && !force) {
      record(`.env: ${key}`, true, `already set to a different value (${existingValue}) — left as-is; update .env by hand if that's stale.`);
      return;
    }
    writeFileSync(ENV_PATH, content.replace(lineRegex, `${key}=${value}`), "utf8");
    record(`.env: ${key}`, true, `${existingValue.length > 0 ? `updated (was ${existingValue}) to` : "set to"} ${value}.`);
    return;
  }

  const anchorRegex = /^DISCORD_STATUS_CHANNEL_ID=.*$/m;
  const updated = anchorRegex.test(content)
    ? content.replace(anchorRegex, (line) => `${line}\n${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`;
  writeFileSync(ENV_PATH, updated, "utf8");
  record(`.env: ${key}`, true, `added ${key}=${value}.`);
}

/** Retries once after a short delay — covers Discord's occasional brief lag between a permission-overwrite PUT taking effect and it being honored by the next request. */
async function withPermissionPropagationRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { status?: number }).status !== 403) throw err;
    await sleep(3000);
    return fn();
  }
}

/**
 * Idempotently posts (or updates in place) a marker-titled embed message,
 * then best-effort pins it. Content delivery and pinning are tracked as
 * separate outcomes: pinning requires the "Manage Messages" permission,
 * which Discord will not let the bot grant to itself via an overwrite if
 * its role doesn't already hold that permission (a hard platform rule, not
 * something fixable from this script) — so if pinning fails, the message
 * still gets posted/updated successfully and that's reported as a clean
 * partial success, not a failure, with a clear note on how to fix pinning.
 *
 * Idempotency is checked against recent CHANNEL MESSAGES (not just pins),
 * so re-running this script keeps updating the same message in place even
 * when it was never successfully pinned.
 */
async function ensurePinnedMessage(rest: REST, botId: string, channelId: string, markerTitle: string, embeds: ReturnType<EmbedBuilder["toJSON"]>[]): Promise<void> {
  let messageId: string;
  let alreadyPinned = false;

  try {
    const recent = await withPermissionPropagationRetry(() => rest.get(`/channels/${channelId}/messages?limit=50`) as Promise<DiscordMessage[]>);
    const existing = recent.find((m) => m.author?.id === botId && m.embeds?.[0]?.title === markerTitle);

    if (existing) {
      await withPermissionPropagationRetry(() => rest.patch(`/channels/${channelId}/messages/${existing.id}`, { body: { embeds } }));
      messageId = existing.id;
      alreadyPinned = Boolean((existing as DiscordMessage & { pinned?: boolean }).pinned);
      record(`Message "${markerTitle}"`, true, `already existed in channel ${channelId} — updated in place.`);
    } else {
      const created = await withPermissionPropagationRetry(
        () => rest.post(`/channels/${channelId}/messages`, { body: { embeds } }) as Promise<DiscordMessage>,
      );
      messageId = created.id;
      record(`Message "${markerTitle}"`, true, `posted new message in channel ${channelId}.`);
    }
  } catch (err) {
    record(`Message "${markerTitle}"`, false, `failed for channel ${channelId}: ${(err as Error).message}`);
    return;
  }

  if (alreadyPinned) {
    record(`Pin "${markerTitle}"`, true, "already pinned.");
    return;
  }

  try {
    await rest.put(`/channels/${channelId}/pins/${messageId}`);
    record(`Pin "${markerTitle}"`, true, `pinned in channel ${channelId}.`);
  } catch (err) {
    record(
      `Pin "${markerTitle}"`,
      false,
      `message posted, but could not pin (bot's role lacks "Manage Messages", which Discord requires to pin — and won't let the bot grant to itself). ` +
        'To enable auto-pin, a server admin can toggle "Manage Messages" on for the Orc Butler role under Server Settings -> Roles.',
    );
  }
}

async function setOverwrite(rest: REST, channelId: string, id: string, type: 0 | 1, allow: bigint | undefined, deny: bigint | undefined): Promise<void> {
  await rest.put(`/channels/${channelId}/permissions/${id}`, {
    body: {
      type,
      allow: (allow ?? 0n).toString(),
      deny: (deny ?? 0n).toString(),
    },
  });
}

async function lockToReadOnly(rest: REST, guildId: string, botId: string, channel: DiscordChannel): Promise<void> {
  try {
    await setOverwrite(rest, channel.id, guildId, OVERWRITE_TYPE_ROLE, undefined, PermissionFlagsBits.SendMessages);
    await setOverwrite(rest, channel.id, botId, OVERWRITE_TYPE_MEMBER, PermissionFlagsBits.SendMessages, undefined);
    record(`Permissions #${channel.name}`, true, "@everyone: deny Send Messages · bot: allow Send Messages.");
  } catch (err) {
    record(`Permissions #${channel.name}`, false, `failed: ${(err as Error).message}`);
  }
}

async function lockBidLeads(rest: REST, guildId: string, botId: string, channel: DiscordChannel): Promise<void> {
  try {
    await setOverwrite(rest, channel.id, guildId, OVERWRITE_TYPE_ROLE, PermissionFlagsBits.AddReactions, PermissionFlagsBits.SendMessages);
    await setOverwrite(
      rest,
      channel.id,
      botId,
      OVERWRITE_TYPE_MEMBER,
      PermissionFlagsBits.SendMessages | PermissionFlagsBits.AddReactions,
      undefined,
    );
    record(`Permissions #${channel.name}`, true, "@everyone: deny Send Messages, allow Add Reactions · bot: allow Send Messages + Add Reactions.");
  } catch (err) {
    record(`Permissions #${channel.name}`, false, `failed: ${(err as Error).message}`);
  }
}

async function lockCommandsChannel(rest: REST, guildId: string, botId: string, channel: DiscordChannel): Promise<void> {
  try {
    await setOverwrite(rest, channel.id, guildId, OVERWRITE_TYPE_ROLE, PermissionFlagsBits.UseApplicationCommands, PermissionFlagsBits.SendMessages);
    await setOverwrite(rest, channel.id, botId, OVERWRITE_TYPE_MEMBER, PermissionFlagsBits.SendMessages, undefined);
    record(`Permissions #${channel.name}`, true, "@everyone: deny Send Messages, allow Use Application Commands · bot: allow Send Messages.");
  } catch (err) {
    record(`Permissions #${channel.name}`, false, `failed: ${(err as Error).message}`);
  }
}

async function openGeneral(rest: REST, guildId: string, channel: DiscordChannel): Promise<void> {
  try {
    await setOverwrite(rest, channel.id, guildId, OVERWRITE_TYPE_ROLE, PermissionFlagsBits.SendMessages, undefined);
    record(`Permissions #${channel.name}`, true, "@everyone: allow Send Messages (left open).");
  } catch (err) {
    record(`Permissions #${channel.name}`, false, `failed: ${(err as Error).message}`);
  }
}

function buildSopEmbeds(): ReturnType<EmbedBuilder["toJSON"]>[] {
  const principle = new EmbedBuilder()
    .setTitle(SOP_TITLE)
    .setColor(0x6ea8fe)
    .setDescription(
      "**Principle:** every channel has ONE exclusive purpose and one owning role. " +
        "If a message doesn't match a channel's purpose, it doesn't belong there.",
    )
    .addFields(
      { name: "👤 Operator (you)", value: "Commands, reactions, full access — the only human with write access.", inline: false },
      {
        name: "🤖 Orc Butler (bot)",
        value: "Posts to feeds/logs/status. Honors only the Operator's input. Cannot sign or move funds — DRY-RUN always.",
        inline: false,
      },
      { name: "👀 Observer (optional, future)", value: "Read-only.", inline: false },
    );

  const channelMap = new EmbedBuilder()
    .setTitle("Channel map")
    .setColor(0x6ea8fe)
    .addFields(
      {
        name: "📖 INFORMATION (static, read-only)",
        value: "#welcome — orientation\n#how-it-works — the rulebook (emoji + command reference)\n#server-guide — this SOP\n#butler-status — bot health board (bot-only)",
        inline: false,
      },
      {
        name: "📣 NOTIFICATIONS (bot posts, humans read-only)",
        value:
          "#bid-leads — buy-opportunity leads, the ONLY interactive channel: use the Accept/Deny/Watch buttons (or react ✅❌👀), don't type (hourly).\n" +
          "  Also carries 👀 watch follow-ups (price drop, sold, likely delisted) and 🐋 whale activity unless a separate channel is configured.\n" +
          "#new-listings — new listings for allowlisted collections (hourly)\n" +
          "#trend-alerts — twice-daily trend/floor digest at 8:00 AM & 8:00 PM local, each with a floor/volume chart; also the 🌅 once-daily overnight recap\n" +
          "#watchlist-sales — recent sales for your watched collections (hourly, bot-only feed)",
        inline: false,
      },
      {
        name: "⚙️ AUTOMATION",
        value: "#butler-commands — run slash commands here\n#order-log — append-only dry-run order records\n#audit-log — append-only security/config/error events",
        inline: false,
      },
      { name: "💬 GENERAL", value: "#general — your scratch/notes, the only place chatter is allowed", inline: false },
    );

  const safety = new EmbedBuilder()
    .setTitle("Safety invariants")
    .setColor(0xe6a23c)
    .setDescription(
      "• **DRY-RUN always on** — never signs or broadcasts a transaction.\n" +
        "• **Allowlist-only** — nothing outside marked collections is ever surfaced. Whale tracking is scoped to allowlisted collections too: a tracked wallet's activity elsewhere is never reported.\n" +
        "• **/portfolio is READ-ONLY** — a public address resolved from ENS. The bot holds no private key, makes no wallet connection, and cannot sign or spend.\n" +
        "• Only the Operator's button clicks/reactions/commands are ever honored.",
    );

  return [principle.toJSON(), channelMap.toJSON(), safety.toJSON()];
}

function buildCommandsEmbeds(): ReturnType<EmbedBuilder["toJSON"]>[] {
  const reference = new EmbedBuilder()
    .setTitle(COMMANDS_TITLE)
    .setColor(0x6ea8fe)
    .setDescription(
      "This channel is the technical/instructional reference. Commands are **Operator-only**, " +
        "**allowlist-only**, and **DRY-RUN** — nothing here ever signs or broadcasts, and nothing " +
        "outside watchlist.json is ever surfaced.",
    )
    .addFields(
      {
        name: "Bid-lead cards (#bid-leads)",
        value:
          "Accept/Deny/Watch buttons (or react ✅❌👀 — same effect). Accept shows a Confirm/Cancel step first; " +
          "nothing is registered until Confirm is clicked, and it only ever builds a dry-run buy order — never signs or broadcasts. " +
          "Deny dismisses the lead; Watch tracks the token for price changes. The card updates in place " +
          "(✅ ACCEPTED / ❌ DENIED / 👀 WATCHING badge + color) once decided.",
        inline: false,
      },
      {
        name: "/watchlist add|remove|list|create-rule",
        value:
          "Manage the allowlist. `add collection:<name|slug|address>` · `remove collection:<...>` · `list` · `create-rule`\n" +
          "**`add` can also scope to a trait**: pass `trait_category` + `trait_value` (both autocompleted from the collection's real trait " +
          "catalog) and only items with that trait produce leads/listings/alerts for the entry. Omit them for the whole collection. " +
          "A trait that isn't in the collection is rejected, and the same collection can be added again under a different trait.",
        inline: false,
      },
      { name: "/listings collection: hours:", value: "Recent listings within the past N hours (default 24).", inline: false },
      { name: "/floor collection:", value: "Current floor price and stats.", inline: false },
      { name: "/offers collection:", value: "Current top offers/bids.", inline: false },
      {
        name: "/status",
        value:
          "Full dashboard: mode, data source, uptime, last poll/trend-check, OpenSea rate-limit health, next trend digest and daily recap, " +
          "watched-item and tracked-wallet counts, the read-only portfolio address, per-collection activity since startup.",
        inline: false,
      },
      { name: "/help", value: "Lists all commands (in-Discord).", inline: false },
    );

  const groupThree = new EmbedBuilder()
    .setTitle("Watch · Whales · Config · Portfolio")
    .setColor(0x5865f2)
    .addFields(
      {
        name: "👀 /watching list · /watching remove collection: token_id:",
        value:
          "Marking a lead 👀 (button or reaction) adds it to a **persisted** watch set that survives restarts. " +
          "Each watched item then generates follow-ups on every poll: **price drop/change**, **sold** (with the sale price vs. what you watched it at), " +
          "and **likely delisted**. Sold/delisted stop watching automatically.",
        inline: false,
      },
      {
        name: "🐋 /whale add address: label: · /whale remove address: · /whale list",
        value:
          "Track wallet addresses. You get an alert when a tracked wallet **BUYS, SELLS, or LISTS inside an allowlisted collection** — " +
          "scoped strictly to your watchlist, deduped per event, and rate-limited through the same per-entry limiter as bid leads. " +
          "Costs no extra API calls: it reads the listings/sales each poll already fetches.",
        inline: false,
      },
      {
        name: "⚙️ /config show · set · reset · entry",
        value:
          "Edit tunables live, no restart. `set key: value:` for globals (show_usd, floor_move_threshold_percent, new_listing_max_price, " +
          "offer_above_collection_percent, trend_alert_times, daily_recap_time). `entry collection: key: value:` for per-collection settings " +
          "(muted, enabled, target_buy_price, max_floor, bid-spread bounds, dedupe/rate limits, quiet hours, priority tier). " +
          "Every value is validated before it's written to watchlist.json; `reset` drops an override back to the .env value.",
        inline: false,
      },
      {
        name: "📦 /portfolio — READ-ONLY",
        value:
          "Holdings for the configured public address (resolved from an ENS name), grouped by collection with floor value and offers received.\n" +
          "**This is strictly read-only.** The bot holds no private key or seed phrase, performs no wallet connection, signs nothing, and " +
          "cannot buy, sell, transfer, or approve anything. ENS resolution and all portfolio reads are read-only calls against public data.",
        inline: false,
      },
      {
        name: "📊 Charts & recap",
        value:
          "The twice-daily trend digest attaches a floor/volume chart per moving collection, rendered locally (no external image service). " +
          "A 🌅 once-daily overnight recap summarizes the past 24h across every watched collection — top gainer/loser, listings, sales, and leads.",
        inline: false,
      },
    );

  return [reference.toJSON(), groupThree.toJSON()];
}

main().catch((err) => {
  console.error("[setup-server] Fatal error:", err);
  process.exit(1);
});
