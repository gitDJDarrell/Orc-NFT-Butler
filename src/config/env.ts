import "dotenv/config";
import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v?.trim().toLowerCase() === "true");

const numberFromString = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) ? n : fallback;
    });

const addressListFromString = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const envSchema = z.object({
  DRY_RUN: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v.trim().toLowerCase() !== "false"), // default-safe: anything but explicit "false" stays dry-run

  OPENSEA_API_KEY: z.string().optional().default(""),
  OPENSEA_BASE_URL: z.string().default("https://api.opensea.io/api/v2"),

  CHAIN_ID: numberFromString(1),
  CHAIN_NAME: z.string().default("ethereum"),
  RPC_URL: z.string().optional().default(""),
  WALLET_ADDRESS: z.string().optional().default(""),

  DISCORD_WEBHOOK_URL: z.string().optional().default(""),

  // Discord bot (gateway) — separate from the simple webhook above. See
  // src/discord-bot/ and the README "Discord bot" section for setup.
  DISCORD_BOT_TOKEN: z.string().optional().default(""),
  DISCORD_BID_LEADS_CHANNEL_ID: z.string().optional().default(""),
  DISCORD_NEW_LISTINGS_CHANNEL_ID: z.string().optional().default(""),
  DISCORD_TREND_ALERTS_CHANNEL_ID: z.string().optional().default(""),
  DISCORD_ORDER_LOG_CHANNEL_ID: z.string().optional().default(""),
  DISCORD_AUDIT_LOG_CHANNEL_ID: z.string().optional().default(""),
  DISCORD_STATUS_CHANNEL_ID: z.string().optional().default(""),
  DISCORD_SALES_CHANNEL_ID: z.string().optional().default(""),
  /** The only Discord user ID whose reactions on bid-lead messages, and whose slash-command invocations, are honored. */
  DISCORD_AUTHORIZED_USER_ID: z.string().optional().default(""),
  /** Optional: pin slash-command registration to one guild ID. If unset, commands register in every guild the bot is currently in. */
  DISCORD_GUILD_ID: z.string().optional().default(""),

  /** Path to the allowlist-only bid-lead watchlist config, relative to the project root. */
  WATCHLIST_CONFIG_PATH: z.string().default("watchlist.json"),

  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: numberFromString(587),
  SMTP_SECURE: boolFromString,
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  EMAIL_FROM: z.string().optional().default(""),
  EMAIL_TO: z.string().optional().default(""),

  DASHBOARD_PORT: numberFromString(3000),

  /** How often bid leads + new-listing checks poll allowlisted collections. Default 3600s (hourly). */
  POLL_INTERVAL_SECONDS: numberFromString(3600),
  WATCHED_COLLECTIONS: addressListFromString,
  FLOOR_MOVE_THRESHOLD: numberFromString(0.05),
  NEW_LISTING_MAX_PRICE: numberFromString(0.5),

  /** Comma-separated 24h local times (HH:MM) the twice-daily trend/floor-move digest runs at — NOT tied to POLL_INTERVAL_SECONDS. */
  TREND_ALERT_TIMES: z.string().default("08:00,20:00"),

  /** An individual token/trait offer must beat the top collection-wide offer by at least this many percent to be flagged as an above-market bid lead. Cuts noise from offers that are only marginally better. */
  OFFER_ABOVE_COLLECTION_THRESHOLD_PERCENT: numberFromString(10),

  /** On a brand-new collection's very first poll (no persisted baseline yet — see watchlist/seenStore.ts), sales older than this many minutes are silently baselined (never posted); only sales within this window are surfaced. Keeps a fresh start from dumping the collection's full sale history while still showing genuinely recent activity. */
  SALES_LOOKBACK_MINUTES: numberFromString(30),

  /** Shows a "(~$X)" USD estimate alongside every ETH-denominated price, using a live ETH/USD rate (see OpenSeaClient.getEthUsdRate). Default-safe like DRY_RUN: anything but explicit "false" leaves it on. */
  SHOW_USD: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v.trim().toLowerCase() !== "false"),

  /** Budget for OpenSeaClient's request scheduler (src/opensea/requestScheduler.ts) — every OpenSea API call is queued and paced against this. Default 50/min, safely under the free-tier ~60/min cap; lower it if you're still seeing 429s, raise it if you have a higher-limit key. */
  OPENSEA_REQUESTS_PER_MINUTE: numberFromString(50),
});

export type AppConfig = z.infer<typeof envSchema> & {
  hasOpenSeaKey: boolean;
  discordEnabled: boolean;
  discordBotEnabled: boolean;
  emailEnabled: boolean;
};

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const data = parsed.data;

  return {
    ...data,
    hasOpenSeaKey: data.OPENSEA_API_KEY.length > 0,
    discordEnabled: data.DISCORD_WEBHOOK_URL.length > 0,
    discordBotEnabled: data.DISCORD_BOT_TOKEN.length > 0,
    emailEnabled: Boolean(
      data.SMTP_HOST && data.SMTP_USER && data.SMTP_PASS && data.EMAIL_FROM && data.EMAIL_TO,
    ),
  };
}

export const config = loadConfig();

export function logConfigSummary(): void {
  console.log("=== NFT/DeFi Agent configuration ===");
  console.log(`  DRY_RUN:              ${config.DRY_RUN} ${config.DRY_RUN ? "" : "  <-- LIVE EXECUTION IS NOT IMPLEMENTED, THIS HAS NO EFFECT YET"}`);
  console.log(`  Chain:                ${config.CHAIN_NAME} (id ${config.CHAIN_ID})`);
  console.log(`  OpenSea base URL:     ${config.OPENSEA_BASE_URL}`);
  console.log(`  OpenSea API key:      ${config.hasOpenSeaKey ? "present" : "MISSING -> using mock data"}`);
  console.log(`  Wallet address:       ${config.WALLET_ADDRESS || "(none configured — read-only)"}`);
  console.log(`  Discord webhook:      ${config.discordEnabled ? "enabled" : "disabled -> console only"}`);
  console.log(`  Discord bot:          ${config.discordBotEnabled ? "enabled" : "disabled (no DISCORD_BOT_TOKEN)"}`);
  console.log(`  Slash commands guild: ${config.DISCORD_GUILD_ID || "(all guilds the bot is in)"}`);
  console.log(`  Email notify:         ${config.emailEnabled ? "enabled" : "disabled -> console only"}`);
  console.log(`  Dashboard port:       ${config.DASHBOARD_PORT}`);
  console.log(`  Watchlist config:     ${config.WATCHLIST_CONFIG_PATH}`);
  console.log(`  Poll interval:        ${config.POLL_INTERVAL_SECONDS}s (bid leads + new listings)`);
  console.log(`  Trend alert times:    ${config.TREND_ALERT_TIMES} (local time, twice-daily digest only)`);
  console.log(`  Watched collections:  ${config.WATCHED_COLLECTIONS.length > 0 ? config.WATCHED_COLLECTIONS.join(", ") : "(none — using demo collections)"}`);
  console.log(`  Floor move threshold: ${config.FLOOR_MOVE_THRESHOLD * 100}%`);
  console.log(`  New listing max price:${config.NEW_LISTING_MAX_PRICE}`);
  console.log(`  Above-market offer threshold: +${config.OFFER_ABOVE_COLLECTION_THRESHOLD_PERCENT}% over top collection offer`);
  console.log(`  Sales lookback (new collections): ${config.SALES_LOOKBACK_MINUTES}m`);
  console.log(`  Show USD estimates:   ${config.SHOW_USD ? "enabled" : "disabled"}`);
  console.log(`  OpenSea rate budget:  ${config.OPENSEA_REQUESTS_PER_MINUTE} req/min`);
  console.log("=====================================");
}
