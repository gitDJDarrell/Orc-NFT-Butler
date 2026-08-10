import type { Response } from "express";
import type { Alert, AlertRecord } from "../types/index.js";

/**
 * In-memory alert history + Server-Sent-Events fan-out for the dashboard.
 * This does not detect or generate alerts itself — it only records and
 * rebroadcasts the same Alert objects the agent already sends to Discord/
 * email/console (see agent/index.ts), so the dashboard feed and Discord
 * never disagree about what happened.
 */

const MAX_HISTORY = 200;
const history: AlertRecord[] = [];
const subscribers = new Set<Response>();
let nextId = 1;

export function recordAndBroadcast(alert: Alert): AlertRecord {
  const record: AlertRecord = {
    ...alert,
    id: String(nextId++),
    timestamp: new Date().toISOString(),
  };

  history.unshift(record);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

  const payload = `data: ${JSON.stringify(record)}\n\n`;
  for (const res of subscribers) {
    res.write(payload);
  }

  return record;
}

export function getHistory(): AlertRecord[] {
  return history;
}

export function subscribe(res: Response): void {
  subscribers.add(res);
}

export function unsubscribe(res: Response): void {
  subscribers.delete(res);
}
