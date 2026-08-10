import type { AllowlistEntry, QuietHours } from "./schema.js";

interface EntryRuntimeState {
  /** dedupeKey -> epoch ms it last fired */
  dedupe: Map<string, number>;
  /** epoch ms of each fire in the trailing window, used for the rolling rate limit */
  fireTimestamps: number[];
}

/**
 * Tracks per-entry mute / quiet-hours / dedupe / rate-limit state, purely
 * in memory (resets on restart, same posture as the rest of the agent's
 * runtime state). One instance is shared across a whole poll run so leads
 * across ticks are deduped/rate-limited correctly.
 */
export class LeadLimiter {
  private readonly state = new Map<string, EntryRuntimeState>();

  private stateFor(entryId: string): EntryRuntimeState {
    let s = this.state.get(entryId);
    if (!s) {
      s = { dedupe: new Map(), fireTimestamps: [] };
      this.state.set(entryId, s);
    }
    return s;
  }

  /** Returns a human-readable suppression reason, or null if the entry is allowed to fire right now. */
  check(entry: AllowlistEntry, dedupeKey: string, now: Date = new Date()): string | null {
    if (entry.muted) return "entry is muted";
    if (entry.quietHours && isWithinQuietHours(entry.quietHours, now)) return "within quiet hours";

    const s = this.stateFor(entry.id);
    const nowMs = now.getTime();

    const lastFired = s.dedupe.get(dedupeKey);
    const dedupeWindowMs = entry.dedupeWindowMinutes * 60_000;
    if (lastFired !== undefined && nowMs - lastFired < dedupeWindowMs) {
      return "duplicate lead within dedupe window";
    }

    const hourAgo = nowMs - 60 * 60_000;
    const recentFires = s.fireTimestamps.filter((t) => t > hourAgo);
    if (recentFires.length >= entry.rateLimitPerHour) {
      return "rate limit exceeded for this entry";
    }

    return null;
  }

  /** Records that a lead actually fired. Call only immediately after check() returns null for the same key. */
  recordFired(entry: AllowlistEntry, dedupeKey: string, now: Date = new Date()): void {
    const s = this.stateFor(entry.id);
    const nowMs = now.getTime();
    s.dedupe.set(dedupeKey, nowMs);

    const hourAgo = nowMs - 60 * 60_000;
    s.fireTimestamps = [...s.fireTimestamps.filter((t) => t > hourAgo), nowMs];
  }
}

export function isWithinQuietHours(quietHours: QuietHours, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: quietHours.timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const nowMinutes = hour * 60 + minute;

  const [startH, startM] = quietHours.start.split(":").map(Number);
  const [endH, endM] = quietHours.end.split(":").map(Number);
  const startMinutes = startH! * 60 + startM!;
  const endMinutes = endH! * 60 + endM!;

  if (startMinutes === endMinutes) return false; // zero-length window: never quiet

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Window wraps past midnight, e.g. 23:00 -> 07:00.
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}
