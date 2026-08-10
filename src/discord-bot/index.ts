import type { NftDeFiAgent } from "../agent/index.js";
import { config } from "../config/env.js";
import { resolvePortfolioAddress } from "../portfolio/portfolio.js";
import { BidLeadMonitor } from "../watchlist/leadMonitor.js";
import { createDiscordBotClient, type DiscordBotClient } from "./client.js";

export interface DiscordBotHandle {
  stop(): void;
}

/**
 * Starts the Discord bot (gateway connection) and its bid-lead poller.
 * No-ops safely — logging the exact message below — when no bot token is
 * configured, consistent with the rest of the project's "runs with zero
 * credentials" posture. Never attempts a gateway login without a token.
 */
export async function startDiscordBot(agent: NftDeFiAgent): Promise<DiscordBotHandle | null> {
  if (!config.DISCORD_BOT_TOKEN) {
    console.log("Discord bot: token missing, bot disabled");
    return null;
  }

  if (!config.DISCORD_AUTHORIZED_USER_ID) {
    console.warn("[discord-bot] DISCORD_AUTHORIZED_USER_ID is not set — every reaction will be treated as unauthorized and logged, none will be actioned.");
  }

  let bot: DiscordBotClient;
  // Named handlers rather than the old positional argument list — see
  // BidLeadMonitorOptions. Stores are left at their defaults (the real,
  // persisted-to-disk ones).
  const leadMonitor = new BidLeadMonitor({
    onLead: async (match, candidate) => bot.postBidLead(candidate, match),
    onWatchedChange: async (candidate, previousPrice) => bot.notifyWatchedChange(candidate, previousPrice),
    onNewListing: async (alert) => bot.postNewListing(alert),
    onTrendAlertWithChart: async (alert, chart) => bot.postTrendAlertWithChart(alert, chart),
    onSale: async (sale, collectionName, ethUsdRate) => bot.postSale(sale, collectionName, ethUsdRate),
    onListingRecurrence: async (params) => bot.postListingRecurrence(params),
    onWatchedSold: async (item, sale) => bot.notifyWatchedSold(item, sale),
    onWatchedDelisted: async (item) => bot.notifyWatchedDelisted(item),
    onWhaleActivity: async (activity) => bot.postWhaleActivity(activity),
    onRecap: async (summary, charts) => bot.postRecap(summary, charts),
  });

  bot = createDiscordBotClient(agent, leadMonitor);

  // Resolve the READ-ONLY portfolio address once at startup so /status can
  // show it without blocking on an ENS round-trip. Fire-and-forget: a
  // resolution failure is logged inside and must never block bot login.
  void resolvePortfolioAddress().catch(() => undefined);

  try {
    await bot.login();
  } catch (err) {
    console.error(`[discord-bot] Login failed, bot disabled: ${(err as Error).message}`);
    return null;
  }

  leadMonitor.start();

  return {
    stop: () => {
      leadMonitor.stop();
      void bot.destroy();
    },
  };
}
