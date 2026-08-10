import type { NftDeFiAgent } from "../agent/index.js";
import { config } from "../config/env.js";
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
  const leadMonitor = new BidLeadMonitor(
    async (match, candidate) => bot.postBidLead(candidate, match),
    async (candidate, previousPrice) => bot.notifyWatchedChange(candidate, previousPrice),
    async (alert) => bot.postNewListing(alert),
    async (alert) => bot.postTrendAlert(alert),
    async (sale, collectionName, ethUsdRate) => bot.postSale(sale, collectionName, ethUsdRate),
    undefined, // seenStore: use the default (real, persisted-to-disk) store
    async (params) => bot.postListingRecurrence(params),
  );

  bot = createDiscordBotClient(agent, leadMonitor);

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
