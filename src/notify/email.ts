import nodemailer from "nodemailer";
import { config } from "../config/env.js";
import type { Alert } from "../types/index.js";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    });
  }
  return transporter;
}

/** Sends an alert via SMTP email. No-op-safe: caller checks config.emailEnabled first. */
export async function notifyEmail(alert: Alert): Promise<void> {
  const html = `
    <h2>${escapeHtml(alert.title)}</h2>
    <p>${escapeHtml(alert.message)}</p>
    ${alert.data ? `<pre>${escapeHtml(JSON.stringify(alert.data, null, 2))}</pre>` : ""}
  `.trim();

  await getTransporter().sendMail({
    from: config.EMAIL_FROM,
    to: config.EMAIL_TO,
    subject: `[NFT/DeFi Agent] ${alert.title}`,
    text: `${alert.title}\n\n${alert.message}${alert.data ? `\n\n${JSON.stringify(alert.data, null, 2)}` : ""}`,
    html,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
