import fs from "node:fs";
import path from "node:path";
import { allowlistConfigSchema, type AllowlistConfig } from "./schema.js";

/**
 * Loads and validates the allowlist config file (default: watchlist.json at
 * the project root; override with WATCHLIST_CONFIG_PATH). Missing file or
 * empty entries list is not an error — it just means the bid-lead pipeline
 * has nothing to watch yet (fail-closed, matching "allowlist-only").
 */
export function loadWatchlistConfig(configPath: string): AllowlistConfig {
  const resolved = path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(resolved)) {
    console.warn(
      `[watchlist] Config file not found at ${resolved} — no collections are allowlisted, bid-lead generation will produce nothing until you add entries.`,
    );
    return { entries: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new Error(`[watchlist] Failed to parse ${resolved}: ${(err as Error).message}`);
  }

  const parsed = allowlistConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`[watchlist] Invalid ${resolved}:\n${issues}`);
  }

  return parsed.data;
}

/** Unique, enabled collection IDs across every allowlist entry — the only collections the bid-lead pipeline will ever poll. */
export function getAllowlistedCollectionIds(config: AllowlistConfig): string[] {
  const ids = new Set<string>();
  for (const entry of config.entries) {
    if (entry.enabled) ids.add(entry.collection);
  }
  return [...ids];
}

/**
 * Writes the allowlist config back to disk (used by /watchlist add|remove).
 * Validates against the same schema before writing, so a bug upstream can't
 * corrupt watchlist.json into something loadWatchlistConfig would reject on
 * the next read.
 */
export function saveWatchlistConfig(configToSave: AllowlistConfig, configPath: string): void {
  const parsed = allowlistConfigSchema.safeParse(configToSave);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`[watchlist] Refusing to write invalid config:\n${issues}`);
  }

  const resolved = path.resolve(process.cwd(), configPath);
  fs.writeFileSync(resolved, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
}
