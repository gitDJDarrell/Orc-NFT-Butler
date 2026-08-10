import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** What a marked wallet did. Scoped strictly to allowlisted collections — see BidLeadMonitor.checkWhaleActivity. */
export type WhaleAction = "bought" | "sold" | "listed";

export interface WhaleWallet {
  /** Always stored lowercased — every lookup is case-insensitive. */
  address: string;
  /** Free-text operator label, e.g. "punk whale". Defaults to a shortened address. */
  label: string;
  addedAt: string;
}

/** One detected whale event, ready to post. */
export interface WhaleActivity {
  wallet: WhaleWallet;
  action: WhaleAction;
  collectionId: string;
  collectionName: string;
  tokenId: string;
  priceNative: number;
  priceCurrency: string;
  timestamp: string;
  /** Sales only — sourced from the sale event. */
  transactionHash?: string;
  imageUrl?: string;
  /** The counterparty, when the event has one (sale buyer/seller). */
  counterparty?: string;
  ethUsdRate?: number;
}

interface WhaleState {
  [addressLowercase: string]: WhaleWallet;
}

/** Hard cap so a runaway `/whale add` loop can't grow the file (and the per-tick scan) without bound. */
const MAX_WHALES = 200;

export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Case-insensitive on the `0x` prefix too — a pasted/uppercased address is still a valid address, and rejecting it would surface as a confusing "not a valid address" instead of the real outcome. */
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/i;

export function isValidAddress(input: string): boolean {
  return ADDRESS_RE.test(input.trim());
}

/**
 * The persisted set of wallets whose activity inside ALLOWLISTED
 * collections generates alerts. Same load-on-construct / save-on-write
 * pattern as SeenStore / WatchStore / ListingAnchorStore, so it survives
 * restarts.
 *
 * Note this store holds only PUBLIC wallet addresses being observed — it
 * has no relationship to any wallet the operator controls, and nothing here
 * can spend, sign, or transact.
 */
export class WhaleStore {
  private readonly path: string;
  private state: WhaleState;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): WhaleState {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as WhaleState;
    } catch (err) {
      console.warn(`[whale-store] failed to read ${this.path}, starting fresh: ${(err as Error).message}`);
      return {};
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.state), "utf8");
    } catch (err) {
      console.warn(`[whale-store] failed to write ${this.path}: ${(err as Error).message}`);
    }
  }

  /** Returns false (without adding) if the address is malformed, already tracked, or the cap is reached. */
  add(address: string, label?: string): { ok: boolean; message: string; wallet?: WhaleWallet } {
    const trimmed = address.trim();
    if (!isValidAddress(trimmed)) {
      return { ok: false, message: `\`${trimmed}\` is not a valid 0x wallet address (expected 42 characters).` };
    }

    const key = trimmed.toLowerCase();
    if (this.state[key]) {
      return { ok: false, message: `\`${shortAddress(key)}\` is already tracked as **${this.state[key]!.label}**.` };
    }
    if (Object.keys(this.state).length >= MAX_WHALES) {
      return { ok: false, message: `Whale list is full (${MAX_WHALES} max) — remove one first.` };
    }

    const wallet: WhaleWallet = {
      address: key,
      label: label?.trim() || shortAddress(key),
      addedAt: new Date().toISOString(),
    };
    this.state[key] = wallet;
    this.save();
    return { ok: true, message: `Now tracking **${wallet.label}** (\`${key}\`).`, wallet };
  }

  remove(address: string): { ok: boolean; message: string } {
    const key = address.trim().toLowerCase();
    const existing = this.state[key];
    if (!existing) {
      return { ok: false, message: `\`${shortAddress(key)}\` isn't being tracked.` };
    }
    delete this.state[key];
    this.save();
    return { ok: true, message: `Stopped tracking **${existing.label}** (\`${key}\`).` };
  }

  /** Case-insensitive lookup — OpenSea returns mixed-case addresses. */
  get(address: string | undefined): WhaleWallet | undefined {
    if (!address) return undefined;
    return this.state[address.trim().toLowerCase()];
  }

  getAll(): WhaleWallet[] {
    return Object.values(this.state).sort((a, b) => a.label.localeCompare(b.label));
  }

  get size(): number {
    return Object.keys(this.state).length;
  }
}
