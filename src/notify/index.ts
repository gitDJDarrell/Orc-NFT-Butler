import { config } from "../config/env.js";
import type { Alert } from "../types/index.js";
import { notifyConsole } from "./console.js";
import { notifyDiscord } from "./discord.js";
import { notifyEmail } from "./email.js";

/**
 * Dispatches an alert to every configured channel. Always logs to console.
 * Discord/email are attempted only if configured, and failures there are
 * caught and logged rather than thrown, so one bad channel never blocks
 * the others or crashes the monitor loop.
 */
export async function dispatchAlert(alert: Alert): Promise<void> {
  notifyConsole(alert);

  const tasks: Promise<void>[] = [];

  if (config.discordEnabled) {
    tasks.push(
      notifyDiscord(alert).catch((err) => {
        console.error(`[notify] Discord delivery failed: ${(err as Error).message}`);
      }),
    );
  }

  if (config.emailEnabled) {
    tasks.push(
      notifyEmail(alert).catch((err) => {
        console.error(`[notify] Email delivery failed: ${(err as Error).message}`);
      }),
    );
  }

  await Promise.all(tasks);
}
