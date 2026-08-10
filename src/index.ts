import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NftDeFiAgent } from "./agent/index.js";
import { startDiscordBot } from "./discord-bot/index.js";

/**
 * CLI entry point.
 *
 *   npm run dev                 -> start the monitor loop (default)
 *   npm run dev -- --demo-order -> also submit one example dry-run order and exit
 *   npm run dev -- --once       -> run a single poll cycle and exit (no interval loop)
 */

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_FILE = join(PROJECT_ROOT, ".bot.lock");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the PID exists but we can't signal it (still alive, just
    // not ours to touch) — anything else (ESRCH on POSIX, or Windows'
    // equivalent "no such process") means it's gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Guarantees at most one long-running bot instance is ever posting to
 * Discord at once — necessary now that the bot can be started via a logon
 * task, a 5-minute watchdog task, AND a manual launch, any of which could
 * otherwise race. A live lock means someone else is already up: that's the
 * expected, healthy outcome for a watchdog check-in, so this exits cleanly
 * (code 0, not an error) rather than crashing/retrying. A lock left behind
 * by a process that's no longer alive (e.g. a hard `taskkill /F`, which
 * skips Node's normal exit handlers) is treated as stale and reclaimed.
 */
function acquireSingleInstanceLock(): void {
  if (existsSync(LOCK_FILE)) {
    const existingPid = Number(readFileSync(LOCK_FILE, "utf8").trim());
    if (Number.isInteger(existingPid) && isProcessAlive(existingPid)) {
      console.log(`[cli] Another instance is already running (pid ${existingPid}) — exiting cleanly.`);
      process.exit(0);
    }
    console.log(`[cli] Found a stale lock (pid ${existingPid || "?"} is not running) — reclaiming it.`);
  }
  writeFileSync(LOCK_FILE, String(process.pid), "utf8");

  process.on("exit", () => {
    try {
      if (existsSync(LOCK_FILE) && readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) {
        unlinkSync(LOCK_FILE);
      }
    } catch {
      // best effort — a lock left behind here is self-healing on next launch
    }
  });
}

function printDemoOrder(agent: NftDeFiAgent): void {
  const watched = agent.monitor.getWatchedCollections();
  const exampleCollection = watched[0] ?? "0x5af0d9827e0c53e4799bb226655a1de152a425a";

  console.log("\n=== Demo order intake ===");
  const result = agent.submitOrder({
    action: "bid",
    collectionId: exampleCollection,
    priceNative: 1.5,
    priceCurrency: "ETH",
    requestedBy: "cli-demo",
  });

  if (result.ok) {
    console.log("Order accepted (dry-run):");
    console.log(JSON.stringify(result.dryRun, null, 2));
  } else {
    console.log("Order rejected:", result.errors);
  }
  console.log("==========================\n");
}

/**
 * Long-running process guards. Without these, a single unhandled rejection
 * anywhere (e.g. a fire-and-forget async call inside a poll tick or a
 * Discord event handler) takes the whole bot down with no trace in the log
 * — Node's default behavior for unhandled rejections is to terminate. We'd
 * rather log and keep the gateway connection + poll loop alive; an
 * uncaughtException is less safe to continue past, so that one still exits,
 * but only after the error is guaranteed to hit the log.
 */
function installCrashGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[fatal] Unhandled promise rejection (continuing):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[fatal] Uncaught exception, exiting:", err);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  installCrashGuards();
  const args = new Set(process.argv.slice(2));
  const agent = new NftDeFiAgent();

  if (args.has("--demo-order")) {
    agent.start();
    printDemoOrder(agent);
    agent.stop();
    return;
  }

  if (args.has("--once")) {
    console.log("[cli] Running a single poll cycle (--once)...");
    await agent.monitor.pollOnce();
    console.log("[cli] Done.");
    return;
  }

  acquireSingleInstanceLock();

  agent.start();
  const bot = await startDiscordBot(agent);

  const shutdown = () => {
    console.log("\n[cli] Shutting down...");
    bot?.stop();
    agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Windows has no real SIGTERM delivery to a process it didn't fork as a
  // console-attached child; `taskkill /PID <pid>` (no /F), console close,
  // and logoff/shutdown all surface to Node as SIGHUP instead — without
  // this, "graceful stop" from the service-management script would only
  // ever hard-kill.
  process.on("SIGHUP", shutdown);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
