import type { OrderIntakeResult } from "../orders/intake.js";
import type { BidLeadCandidate } from "../watchlist/candidate.js";
import type { EmbedContent } from "./embeds.js";
import { buildDryRunResultEmbed } from "./embeds.js";
import type { PendingLead, PendingLeadStore } from "./pendingLeads.js";

export const REACTION_ACCEPT = "✅";
export const REACTION_DENY = "❌";
export const REACTION_WATCH = "👀";

export interface ReactionEvent {
  messageId: string;
  emoji: string;
  userId: string;
  username: string;
}

/**
 * Everything the router needs to act, abstracted away from discord.js so
 * this logic — the security-sensitive part (who's authorized, what accept/
 * deny/watch actually do) — can be unit tested with plain mock functions
 * instead of a real gateway connection. src/discord-bot/client.ts supplies
 * the real discord.js-backed implementations.
 */
export interface ReactionRouterDeps {
  authorizedUserId: string;
  leads: PendingLeadStore;
  submitOrder: (raw: unknown) => OrderIntakeResult;
  postToOrderLog: (content: string, embed?: EmbedContent) => Promise<void>;
  postToAuditLog: (content: string) => Promise<void>;
  replyToLead: (messageId: string, content: string, embed?: EmbedContent) => Promise<void>;
  /** Rewrites the lead card to show its decision at a glance — see embeds.ts's applyLeadDecision(). `detail` is an optional short extra note appended to the footer (e.g. "dry-run order built"). */
  annotateLeadMessage: (messageId: string, decision: "accepted" | "denied" | "watching", detail?: string) => Promise<void>;
  watchCandidate: (candidate: BidLeadCandidate) => void;
}

/**
 * Routes one messageReactionAdd event. ONLY the configured authorized user's
 * reactions are ever acted on — everyone else's reactions are logged to the
 * audit channel and otherwise ignored. This is the sole entry point for the
 * ✅/❌/👀 command loop.
 */
export async function routeReaction(deps: ReactionRouterDeps, event: ReactionEvent): Promise<void> {
  if (event.emoji !== REACTION_ACCEPT && event.emoji !== REACTION_DENY && event.emoji !== REACTION_WATCH) {
    return;
  }

  if (!deps.authorizedUserId || event.userId !== deps.authorizedUserId) {
    await deps.postToAuditLog(
      `Unauthorized reaction attempt: user ${event.username} (${event.userId}) reacted ${event.emoji} on lead message ${event.messageId}.`,
    );
    return;
  }

  const lead = deps.leads.get(event.messageId);
  if (!lead) return; // not a tracked bid-lead message — nothing to do

  if (lead.status !== "pending") {
    await deps.replyToLead(event.messageId, `This lead was already marked **${lead.status}** — ignoring.`);
    return;
  }

  switch (event.emoji) {
    case REACTION_ACCEPT:
      await handleAccept(deps, lead);
      return;
    case REACTION_DENY:
      await handleDeny(deps, lead, event.username);
      return;
    case REACTION_WATCH:
      await handleWatch(deps, lead);
      return;
  }
}

async function handleAccept(deps: ReactionRouterDeps, lead: PendingLead): Promise<void> {
  // Routes to the EXISTING dry-run order intake — same validation, same
  // DRY_RUN guard, same builder the CLI/dashboard use. This never signs or
  // broadcasts anything; see src/orders/dryRun.ts and liveExecution.ts.
  const result: OrderIntakeResult = deps.submitOrder({
    action: "buy",
    collectionId: lead.candidate.collectionId,
    tokenId: lead.candidate.tokenId,
    priceNative: lead.candidate.priceNative,
    priceCurrency: lead.candidate.priceCurrency,
    requestedBy: `discord-bot:${lead.candidate.listingId}`,
  });

  deps.leads.setStatus(lead.messageId, "accepted");

  if (result.ok && result.dryRun) {
    const embed = buildDryRunResultEmbed(result.dryRun);
    await deps.replyToLead(lead.messageId, "Dry-run order built — nothing was signed or submitted.", embed);
    await deps.postToOrderLog(`Dry-run BUY built for ${lead.candidate.collectionName} #${lead.candidate.tokenId}.`, embed);
    await deps.postToAuditLog(
      `Lead ${lead.messageId} (${lead.candidate.collectionName} #${lead.candidate.tokenId}) accepted — dry-run order built.`,
    );
  } else {
    const errorText = (result.errors ?? []).join("; ") || "unknown validation error";
    await deps.replyToLead(lead.messageId, `Order rejected: ${errorText}`);
    await deps.postToAuditLog(`Lead ${lead.messageId} accept failed validation: ${errorText}`);
  }

  await deps.annotateLeadMessage(lead.messageId, "accepted", "dry-run order built");
}

async function handleDeny(deps: ReactionRouterDeps, lead: PendingLead, username: string): Promise<void> {
  deps.leads.setStatus(lead.messageId, "denied");
  await deps.annotateLeadMessage(lead.messageId, "denied");
  await deps.postToAuditLog(
    `Lead ${lead.messageId} (${lead.candidate.collectionName} #${lead.candidate.tokenId}) denied by ${username}.`,
  );
}

async function handleWatch(deps: ReactionRouterDeps, lead: PendingLead): Promise<void> {
  deps.leads.setStatus(lead.messageId, "watching");
  deps.watchCandidate(lead.candidate);
  await deps.annotateLeadMessage(lead.messageId, "watching");
  await deps.replyToLead(lead.messageId, `Now watching ${lead.candidate.collectionName} #${lead.candidate.tokenId} for changes.`);
}
