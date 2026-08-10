import { config } from "../config/env.js";
import type { Alert } from "../types/index.js";

/** Sends an alert to a Discord channel via an incoming webhook. No-op-safe: caller checks config.discordEnabled first. */
export async function notifyDiscord(alert: Alert): Promise<void> {
  const color = alert.severity === "warning" ? 0xe67e22 : 0x3498db;

  const payload = {
    embeds: [
      {
        title: alert.title,
        description: alert.message,
        color,
        fields: alert.data
          ? Object.entries(alert.data).map(([name, value]) => ({
              name,
              value: String(value),
              inline: true,
            }))
          : undefined,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(config.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} ${body}`);
  }
}
