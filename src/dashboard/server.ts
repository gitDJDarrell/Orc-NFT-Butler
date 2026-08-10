import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { NftDeFiAgent } from "../agent/index.js";
import { config } from "../config/env.js";
import { startDiscordBot } from "../discord-bot/index.js";
import { notifyDiscord } from "../notify/discord.js";
import * as alertBus from "./alertBus.js";

/**
 * Local web dashboard: a thin view/control surface over the existing
 * agent/monitor/orders/notify modules. It does not reimplement any
 * detection or order logic — it calls straight through to:
 *   - agent.monitor for watchlist reads + add/remove
 *   - agent.submitOrder() (src/orders/intake.ts -> dryRun.ts) for orders,
 *     so the DRY_RUN guard and validation are exactly the same code path
 *     the CLI uses
 *   - the same Alert objects the monitor sends to Discord/email/console,
 *     rebroadcast to the dashboard over SSE (see alertBus.ts)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Two levels up from src/dashboard (or dist/dashboard after build) is the project root.
const publicDir = path.resolve(__dirname, "..", "..", "public");

const agent = new NftDeFiAgent();
agent.addAlertListener((alert) => alertBus.recordAndBroadcast(alert));

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

app.get("/api/status", (_req: Request, res: Response) => {
  res.json({
    dryRun: config.DRY_RUN,
    hasOpenSeaKey: config.hasOpenSeaKey,
    discordEnabled: config.discordEnabled,
    discordBotEnabled: config.discordBotEnabled,
    emailEnabled: config.emailEnabled,
    chain: config.CHAIN_NAME,
    chainId: config.CHAIN_ID,
    pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
  });
});

app.get("/api/watchlist", (_req: Request, res: Response) => {
  res.json(agent.monitor.getWatchlistSnapshot());
});

app.post("/api/watchlist", (req: Request, res: Response) => {
  const collectionId = typeof req.body?.collectionId === "string" ? req.body.collectionId.trim() : "";
  if (!collectionId) {
    res.status(400).json({ ok: false, error: "collectionId is required" });
    return;
  }

  const added = agent.monitor.addCollection(collectionId);
  if (!added) {
    res.status(409).json({ ok: false, error: "Collection is already on the watchlist" });
    return;
  }

  res.status(201).json({ ok: true, watchlist: agent.monitor.getWatchlistSnapshot() });
});

app.delete("/api/watchlist/:id", (req: Request, res: Response) => {
  const removed = agent.monitor.removeCollection(req.params.id);
  if (!removed) {
    res.status(404).json({ ok: false, error: "Collection is not on the watchlist" });
    return;
  }
  res.json({ ok: true, watchlist: agent.monitor.getWatchlistSnapshot() });
});

app.get("/api/alerts", (_req: Request, res: Response) => {
  res.json(alertBus.getHistory());
});

app.get("/api/alerts/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");

  alertBus.subscribe(res);
  req.on("close", () => alertBus.unsubscribe(res));
});

app.post("/api/orders", (req: Request, res: Response) => {
  // Delegates entirely to the existing dry-run order intake pipeline
  // (src/orders/intake.ts) — same validation, same DRY_RUN guard, same
  // dry-run builder the CLI's --demo-order flag uses. No new order logic here.
  const result = agent.submitOrder(req.body);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/discord/test", async (_req: Request, res: Response) => {
  if (!config.discordEnabled) {
    res.status(400).json({ ok: false, error: "DISCORD_WEBHOOK_URL is not configured" });
    return;
  }

  try {
    await notifyDiscord({
      title: "Test alert",
      message: "This is a test message from the NFT/DeFi Agent dashboard.",
      severity: "info",
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

// Fallback so refreshing the page on any client route still serves the SPA shell.
app.get(/^(?!\/api\/).*/, (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[dashboard] unhandled error:", err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

agent.start();
void startDiscordBot(agent);

app.listen(config.DASHBOARD_PORT, () => {
  console.log(`[dashboard] Serving on http://localhost:${config.DASHBOARD_PORT}`);
});
