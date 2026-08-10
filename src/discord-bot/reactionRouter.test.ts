import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrderIntakeResult } from "../orders/intake.js";
import type { BidLeadCandidate } from "../watchlist/candidate.js";
import type { WatchlistMatch } from "../watchlist/evaluate.js";
import type { AllowlistEntry } from "../watchlist/schema.js";
import type { EmbedContent } from "./embeds.js";
import { PendingLeadStore } from "./pendingLeads.js";
import { REACTION_ACCEPT, REACTION_DENY, REACTION_WATCH, routeReaction, type ReactionRouterDeps } from "./reactionRouter.js";

const AUTHORIZED_USER_ID = "user-authorized";

function makeCandidate(overrides: Partial<BidLeadCandidate> = {}): BidLeadCandidate {
  return {
    collectionId: "0xcollection",
    collectionName: "Test Collection",
    tokenId: "42",
    priceNative: 1.5,
    priceCurrency: "ETH",
    floorPriceNative: 1.8,
    percentFromFloor: -16.7,
    source: "opensea",
    listingId: "listing-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    id: "entry-1",
    label: "Test entry",
    enabled: true,
    priorityTier: "watch",
    collection: "0xcollection",
    filters: {},
    muted: false,
    dedupeWindowMinutes: 30,
    rateLimitPerHour: 10,
    ...overrides,
  };
}

/** Records every call made against it — this stands in for the real discord.js-backed client in client.ts. */
function makeMockedDeps(overrides: Partial<ReactionRouterDeps> = {}) {
  const calls = {
    orderLog: [] as Array<{ content: string; embed?: EmbedContent }>,
    auditLog: [] as string[],
    replies: [] as Array<{ messageId: string; content: string; embed?: EmbedContent }>,
    annotations: [] as Array<{ messageId: string; decision: "accepted" | "denied" | "watching"; detail?: string }>,
    watched: [] as BidLeadCandidate[],
  };

  const leads = new PendingLeadStore();

  const deps: ReactionRouterDeps = {
    authorizedUserId: AUTHORIZED_USER_ID,
    leads,
    submitOrder: () => ({ ok: true }) as OrderIntakeResult,
    postToOrderLog: async (content, embed) => {
      calls.orderLog.push({ content, embed });
    },
    postToAuditLog: async (content) => {
      calls.auditLog.push(content);
    },
    replyToLead: async (messageId, content, embed) => {
      calls.replies.push({ messageId, content, embed });
    },
    annotateLeadMessage: async (messageId, decision, detail) => {
      calls.annotations.push({ messageId, decision, detail });
    },
    watchCandidate: (candidate) => {
      calls.watched.push(candidate);
    },
    ...overrides,
  };

  return { deps, calls, leads };
}

test("routeReaction: unauthorized user's reaction is logged to audit and never actioned", async () => {
  const { deps, calls, leads } = makeMockedDeps();
  const match: WatchlistMatch = { entry: makeEntry(), reasoning: ["test"] };
  const lead = leads.add("msg-1", makeCandidate(), match);

  await routeReaction(deps, { messageId: "msg-1", emoji: REACTION_ACCEPT, userId: "some-other-user", username: "Mallory" });

  assert.equal(lead.status, "pending", "an unauthorized reaction must not change lead status");
  assert.equal(calls.replies.length, 0);
  assert.equal(calls.auditLog.length, 1);
  assert.match(calls.auditLog[0]!, /Unauthorized reaction attempt/);
  assert.match(calls.auditLog[0]!, /Mallory/);
});

test("routeReaction: accept from the authorized user builds a dry-run order via the existing intake and never signs anything", async () => {
  let submittedOrder: unknown;
  const { deps, calls, leads } = makeMockedDeps({
    submitOrder: (raw) => {
      submittedOrder = raw;
      return {
        ok: true,
        dryRun: {
          dryRun: true,
          action: "buy",
          summary: "Buy token 42",
          params: {},
          estimatedGasUnits: 150000,
          estimatedGasCostNative: 0.003,
          gasCurrency: "ETH",
          wouldSubmitTo: "OpenSea Seaport fulfillment (fulfill_listing) (NOT called — dry-run only)",
          timestamp: new Date().toISOString(),
        },
      } satisfies OrderIntakeResult;
    },
  });

  const candidate = makeCandidate();
  const match: WatchlistMatch = { entry: makeEntry(), reasoning: ["test"] };
  leads.add("msg-2", candidate, match);

  await routeReaction(deps, { messageId: "msg-2", emoji: REACTION_ACCEPT, userId: AUTHORIZED_USER_ID, username: "Owner" });

  assert.ok(submittedOrder, "submitOrder should have been called");
  assert.deepEqual((submittedOrder as { action: string }).action, "buy");
  assert.deepEqual((submittedOrder as { collectionId: string }).collectionId, candidate.collectionId);
  assert.deepEqual((submittedOrder as { tokenId: string }).tokenId, candidate.tokenId);
  assert.deepEqual((submittedOrder as { priceNative: number }).priceNative, candidate.priceNative);

  assert.equal(leads.get("msg-2")?.status, "accepted");
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0]!.content, /nothing was signed or submitted/i);
  assert.equal(calls.orderLog.length, 1, "accept must also post to the order log");
  assert.equal(calls.auditLog.length, 1, "accept must also post to the audit log");
  assert.equal(calls.annotations.length, 1);
  assert.equal(calls.annotations[0]!.decision, "accepted");
  assert.match(calls.annotations[0]!.detail ?? "", /dry-run order built/);
});

test("routeReaction: accept surfaces an order-intake rejection instead of silently succeeding", async () => {
  const { deps, calls, leads } = makeMockedDeps({
    submitOrder: () => ({ ok: false, errors: ["tokenId is required"] }) as OrderIntakeResult,
  });
  leads.add("msg-3", makeCandidate(), { entry: makeEntry(), reasoning: [] });

  await routeReaction(deps, { messageId: "msg-3", emoji: REACTION_ACCEPT, userId: AUTHORIZED_USER_ID, username: "Owner" });

  assert.equal(leads.get("msg-3")?.status, "accepted");
  assert.match(calls.replies[0]!.content, /rejected/i);
  assert.match(calls.auditLog[0]!, /failed validation/);
});

test("routeReaction: deny marks the lead dismissed and logs to audit without touching order intake", async () => {
  let submitOrderCalled = false;
  const { deps, calls, leads } = makeMockedDeps({
    submitOrder: () => {
      submitOrderCalled = true;
      return { ok: true } as OrderIntakeResult;
    },
  });
  leads.add("msg-4", makeCandidate(), { entry: makeEntry(), reasoning: [] });

  await routeReaction(deps, { messageId: "msg-4", emoji: REACTION_DENY, userId: AUTHORIZED_USER_ID, username: "Owner" });

  assert.equal(submitOrderCalled, false, "deny must never touch order intake");
  assert.equal(leads.get("msg-4")?.status, "denied");
  assert.equal(calls.annotations[0]!.decision, "denied");
  assert.match(calls.auditLog[0]!, /denied by Owner/);
});

test("routeReaction: watch marks the lead watching and registers the candidate for future changes", async () => {
  const { deps, calls, leads } = makeMockedDeps();
  const candidate = makeCandidate();
  leads.add("msg-5", candidate, { entry: makeEntry(), reasoning: [] });

  await routeReaction(deps, { messageId: "msg-5", emoji: REACTION_WATCH, userId: AUTHORIZED_USER_ID, username: "Owner" });

  assert.equal(leads.get("msg-5")?.status, "watching");
  assert.equal(calls.watched.length, 1);
  assert.equal(calls.watched[0]!.tokenId, candidate.tokenId);
  assert.equal(calls.replies.length, 1);
});

test("routeReaction: reacting again on an already-resolved lead doesn't re-run the action", async () => {
  let acceptCount = 0;
  const { deps, leads } = makeMockedDeps({
    submitOrder: () => {
      acceptCount += 1;
      return { ok: true } as OrderIntakeResult;
    },
  });
  leads.add("msg-6", makeCandidate(), { entry: makeEntry(), reasoning: [] });

  await routeReaction(deps, { messageId: "msg-6", emoji: REACTION_ACCEPT, userId: AUTHORIZED_USER_ID, username: "Owner" });
  await routeReaction(deps, { messageId: "msg-6", emoji: REACTION_DENY, userId: AUTHORIZED_USER_ID, username: "Owner" });

  assert.equal(acceptCount, 1, "the second reaction must not re-trigger order intake");
  assert.equal(leads.get("msg-6")?.status, "accepted", "status set by the first action must stick");
});

test("routeReaction: unrelated emoji and unknown message IDs are silently ignored", async () => {
  const { deps, calls } = makeMockedDeps();
  await routeReaction(deps, { messageId: "does-not-exist", emoji: REACTION_ACCEPT, userId: AUTHORIZED_USER_ID, username: "Owner" });
  await routeReaction(deps, { messageId: "does-not-exist", emoji: "🔥", userId: AUTHORIZED_USER_ID, username: "Owner" });
  assert.equal(calls.replies.length, 0);
  assert.equal(calls.auditLog.length, 0);
});
