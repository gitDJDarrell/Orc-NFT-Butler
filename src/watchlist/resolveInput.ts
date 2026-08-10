import type { AllowlistEntry } from "./schema.js";

/**
 * Pure, framework/network-free helpers for resolving a slash command's
 * free-text `collection` input against the watchlist BEFORE falling back to
 * OpenSea's own resolution (address/slug). Solves the "friendly name typed
 * in doesn't match the OpenSea slug" case — e.g. a user typing "super punk
 * world" for an entry labeled "Super Punk World — Nina Chanel Abney", which
 * OpenSea's API has no way to resolve on its own (see opensea/client.ts's
 * resolveCollection doc comment — there is no working free-text search
 * endpoint in OpenSea API v2, verified against the live API).
 */

/** Lowercase, strip everything but letters/digits, so "Super Punk World" and "super-punk-world!!" compare equal. */
export function normalizeName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Finds an ENABLED watchlist entry whose label matches free-text input,
 * ignoring case/spacing/punctuation. Substring match in either direction —
 * a label is typically "Collection Name — subtitle", so the normalized
 * input needs to match a prefix/substring of it, not the whole thing; the
 * reverse direction covers a fuller label typed in against a shorter one.
 */
export function findWatchlistNameMatch(input: string, entries: readonly AllowlistEntry[]): AllowlistEntry | null {
  const normalizedInput = normalizeName(input);
  if (normalizedInput.length === 0) return null;

  const enabled = entries.filter((e) => e.enabled);

  const exact = enabled.find((e) => normalizeName(e.label) === normalizedInput);
  if (exact) return exact;

  return (
    enabled.find((e) => {
      const normalizedLabel = normalizeName(e.label);
      return normalizedLabel.includes(normalizedInput) || normalizedInput.includes(normalizedLabel);
    }) ?? null
  );
}

/** Length of the longest common substring between two strings — a simple, dependency-free closeness score for "did you mean" suggestions. */
function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prevRow: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = prevRow[j - 1]! + 1;
        if (row[j]! > best) best = row[j]!;
      }
    }
    prevRow = row;
  }
  return best;
}

/**
 * Best-effort "did you mean" suggestion among enabled watchlist entries for
 * an input that resolved to nothing — null if nothing is close enough to be
 * a useful suggestion (avoids suggesting an unrelated entry just because it
 * shares a couple of characters).
 */
export function suggestClosestWatchlistEntry(input: string, entries: readonly AllowlistEntry[], minScore = 5): AllowlistEntry | null {
  const normalizedInput = normalizeName(input);
  if (normalizedInput.length === 0) return null;

  let best: { entry: AllowlistEntry; score: number } | null = null;
  for (const entry of entries.filter((e) => e.enabled)) {
    const score = longestCommonSubstringLength(normalizedInput, normalizeName(entry.label));
    if (score >= minScore && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry ?? null;
}
