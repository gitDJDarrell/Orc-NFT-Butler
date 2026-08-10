import type { Alert } from "../types/index.js";

export function notifyConsole(alert: Alert): void {
  const tag = alert.severity === "warning" ? "[ALERT]" : "[info]";
  console.log(`${tag} ${alert.title} — ${alert.message}`);
  if (alert.data) {
    console.log(`         data: ${JSON.stringify(alert.data)}`);
  }
}
