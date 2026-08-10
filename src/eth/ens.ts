import { keccak256, toHex } from "./keccak.js";

/**
 * Minimal, READ-ONLY ENS name -> address resolution over public JSON-RPC.
 *
 * Two `eth_call`s, no dependencies, no wallet:
 *   1. ENS Registry.resolver(namehash) -> the name's resolver contract.
 *   2. Resolver.addr(namehash)         -> the address it points at.
 *
 * SAFETY: `eth_call` is a read-only node method — it simulates a call
 * against current state and returns data. It cannot mutate chain state,
 * cannot spend, and requires no private key or signature. This module never
 * constructs, signs, or broadcasts a transaction; the only RPC method it is
 * capable of issuing is `eth_call`. See src/portfolio/README-SAFETY note in
 * portfolio.ts.
 */

/** ENS Registry — same address on every network ENS supports. */
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** 4-byte selector for a solidity signature, derived (not hardcoded) so it's self-verifying against our keccak implementation. */
function selector(signature: string): string {
  return toHex(keccak256(new TextEncoder().encode(signature))).slice(0, 10);
}

/**
 * ENS namehash (EIP-137): recursively hash labels right-to-left, starting
 * from 32 zero bytes. namehash("") is the zero node; namehash("eth") is the
 * well-known 0x93cdeb70… constant asserted in the tests.
 */
export function namehash(name: string): Uint8Array {
  // Annotated rather than inferred: `new Uint8Array(32)` narrows to
  // Uint8Array<ArrayBuffer>, which keccak256's Uint8Array<ArrayBufferLike>
  // return type can't be reassigned into.
  let node: Uint8Array = new Uint8Array(32); // all zero
  if (name.length === 0) return node;

  const labels = name.toLowerCase().split(".");
  for (let i = labels.length - 1; i >= 0; i--) {
    const labelHash = keccak256(new TextEncoder().encode(labels[i]!));
    const combined = new Uint8Array(64);
    combined.set(node, 0);
    combined.set(labelHash, 32);
    node = keccak256(combined);
  }
  return node;
}

export function namehashHex(name: string): string {
  return toHex(namehash(name));
}

/** Left-pads a 20-byte address to a 32-byte ABI word. */
function padWord(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, "0");
}

/** Reads the trailing 20 bytes of a 32-byte ABI-encoded word as an address. */
function decodeAddress(returnData: string): string | null {
  const clean = returnData.replace(/^0x/, "");
  if (clean.length < 64) return null;
  const word = clean.slice(clean.length - 64);
  const address = `0x${word.slice(24)}`;
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  return address === ZERO_ADDRESS ? null : address;
}

async function ethCall(rpcUrl: string, to: string, data: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // eth_call ONLY — this module is structurally incapable of sending a
      // transaction (no eth_sendTransaction / eth_sendRawTransaction path).
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC responded ${res.status}`);
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? "RPC error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

export interface EnsResolution {
  name: string;
  address: string;
}

/**
 * Resolves an ENS name to its address, or null if the name has no resolver,
 * resolves to the zero address, or every configured RPC endpoint fails.
 * Never throws — a resolution failure degrades to "portfolio unavailable"
 * rather than taking a poll tick or a slash command down with it.
 */
export async function resolveEnsName(name: string, rpcUrls: string[], timeoutMs = 8000): Promise<EnsResolution | null> {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed || !trimmed.includes(".")) return null;

  const node = toHex(namehash(trimmed)).slice(2);
  const resolverCall = `${selector("resolver(bytes32)")}${padWord(node)}`;
  const addrCall = `${selector("addr(bytes32)")}${padWord(node)}`;

  for (const rpcUrl of rpcUrls) {
    try {
      const resolverResult = await ethCall(rpcUrl, ENS_REGISTRY, resolverCall, timeoutMs);
      const resolverAddress = resolverResult ? decodeAddress(resolverResult) : null;
      if (!resolverAddress) {
        console.warn(`[ens] ${trimmed} has no resolver set (via ${rpcUrl}).`);
        continue;
      }

      const addrResult = await ethCall(rpcUrl, resolverAddress, addrCall, timeoutMs);
      const address = addrResult ? decodeAddress(addrResult) : null;
      if (!address) {
        console.warn(`[ens] ${trimmed} resolver returned no address (via ${rpcUrl}).`);
        continue;
      }

      return { name: trimmed, address };
    } catch (err) {
      console.warn(`[ens] resolution of ${trimmed} failed via ${rpcUrl}: ${(err as Error).message}`);
    }
  }

  return null;
}
