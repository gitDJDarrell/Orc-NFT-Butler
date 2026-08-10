import { config, logConfigSummary } from "../config/env.js";
import { CollectionMonitor } from "../monitor/index.js";
import { dispatchAlert } from "../notify/index.js";
import { submitOrderRequest, type OrderIntakeResult } from "../orders/intake.js";
import type { Alert, OrderRequest } from "../types/index.js";

export type AlertListener = (alert: Alert) => void;

/**
 * Orchestrator: wires the collection monitor's alerts to the notification
 * dispatcher, and exposes the order-intake interface for accepting orders.
 *
 * Every alert the monitor fires flows through exactly one path
 * (monitor -> dispatchAlert -> Discord/email/console, then any additional
 * listeners such as the dashboard's SSE feed) so all consumers observe the
 * same alert objects — nothing duplicates the monitor's detection logic.
 */
export class NftDeFiAgent {
  readonly monitor: CollectionMonitor;
  private readonly alertListeners: AlertListener[] = [];

  constructor(collections?: string[]) {
    this.monitor = new CollectionMonitor(async (alert) => {
      await dispatchAlert(alert);
      for (const listener of this.alertListeners) {
        listener(alert);
      }
    }, collections);
  }

  /** Registers an additional observer for every alert the monitor fires (e.g. the dashboard's SSE feed). */
  addAlertListener(listener: AlertListener): void {
    this.alertListeners.push(listener);
  }

  start(): void {
    logConfigSummary();
    if (config.DRY_RUN) {
      console.log("[agent] Running in DRY_RUN mode — no orders will ever be signed or broadcast.");
    } else {
      console.log("[agent] WARNING: DRY_RUN is false, but live execution is not implemented — order intake will refuse all requests.");
    }
    this.monitor.start();
  }

  stop(): void {
    this.monitor.stop();
  }

  /** Order-intake entry point: validate + route to the dry-run order builder. */
  submitOrder(raw: unknown): OrderIntakeResult {
    return submitOrderRequest(raw);
  }
}

export type { OrderRequest, OrderIntakeResult };
