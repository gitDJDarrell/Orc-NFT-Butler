import type { BidLeadCandidate } from "../watchlist/candidate.js";
import type { WatchlistMatch } from "../watchlist/evaluate.js";

export type LeadStatus = "pending" | "accepted" | "denied" | "watching";

export interface PendingLead {
  messageId: string;
  candidate: BidLeadCandidate;
  match: WatchlistMatch;
  status: LeadStatus;
  createdAt: string;
}

/** In-memory index of bid-lead messages the bot has posted, keyed by Discord message ID. Resets on restart. */
export class PendingLeadStore {
  private readonly leads = new Map<string, PendingLead>();

  add(messageId: string, candidate: BidLeadCandidate, match: WatchlistMatch): PendingLead {
    const lead: PendingLead = { messageId, candidate, match, status: "pending", createdAt: new Date().toISOString() };
    this.leads.set(messageId, lead);
    return lead;
  }

  get(messageId: string): PendingLead | undefined {
    return this.leads.get(messageId);
  }

  setStatus(messageId: string, status: LeadStatus): void {
    const lead = this.leads.get(messageId);
    if (lead) lead.status = status;
  }
}
