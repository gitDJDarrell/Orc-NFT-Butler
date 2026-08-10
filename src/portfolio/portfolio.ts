import { config } from "../config/env.js";
import { resolveEnsName } from "../eth/ens.js";
import { openseaClient, type AccountNft } from "../opensea/client.js";

/**
 * ============================ READ-ONLY =============================
 *
 * Portfolio tracking for a PUBLIC Ethereum address. This module — and the
 * `/portfolio` command it backs — is strictly, structurally read-only:
 *
 *   - It holds NO private key, seed phrase, or keystore, and there is no
 *     configuration option to supply one.
 *   - It performs NO wallet connection, and no signing of any kind
 *     (no personal_sign, no eth_signTypedData, no transaction signing).
 *   - It CANNOT spend, transfer, list, bid, approve, or otherwise move any
 *     asset. It issues only HTTP GETs to OpenSea plus, for ENS resolution,
 *     read-only `eth_call`s (see src/eth/ens.ts) — none of which can mutate
 *     chain state.
 *   - The address is treated as a public identifier, exactly like a block
 *     explorer treats one. Observing an address confers no control over it.
 *
 * Anything that would actually place an order still goes through the
 * existing dry-run intake (src/orders/), which is itself gated by DRY_RUN
 * and has no live execution implemented (src/orders/liveExecution.ts).
 * =====================================================================
 */

export interface PortfolioCollectionHolding {
  contract: string;
  collectionName: string;
  count: number;
  /** Floor price per item, or null when the collection's floor couldn't be read. */
  floorNative: number | null;
  floorCurrency: string;
  /** count * floorNative, or null when floor is unknown. */
  estimatedValueNative: number | null;
  /** Best offer currently standing on any sampled token in this collection. */
  topOfferNative?: number;
  topOfferCurrency?: string;
  topOfferTokenId?: string;
}

export interface PortfolioSnapshot {
  /** The ENS name that was resolved, when resolution (rather than an explicit address) was used. */
  ensName?: string;
  address: string;
  totalItems: number;
  holdings: PortfolioCollectionHolding[];
  /** Summed estimated value across collections with a known floor. */
  estimatedTotalNative: number;
  /** Collections whose floor couldn't be read, so the total understates reality. */
  collectionsMissingFloor: number;
  /** True when holdings were truncated by MAX_ITEMS. */
  truncated: boolean;
  ethUsdRate?: number;
  generatedAt: string;
  /** How many tokens were sampled for offers-received (bounded — see MAX_OFFER_LOOKUPS). */
  offersSampled: number;
}

/** Upper bound on holdings pulled — keeps a large wallet from blowing the OpenSea request budget. */
const MAX_ITEMS = 200;

/**
 * Offers are a per-token lookup, so this is deliberately bounded: we sample
 * the largest holdings' tokens rather than querying every item. The embed
 * says how many were sampled so a partial figure is never mistaken for a
 * complete one.
 */
const MAX_OFFER_LOOKUPS = 12;

/** Cache of the resolved address for the process lifetime — ENS records change rarely and this avoids an RPC round-trip per /portfolio. */
let cachedResolution: { ensName?: string; address: string } | null = null;

/**
 * Resolves the configured portfolio address: an explicit PORTFOLIO_ADDRESS
 * wins (no network call at all), otherwise PORTFOLIO_ENS_NAME is resolved
 * once via read-only eth_call and cached.
 */
export async function resolvePortfolioAddress(): Promise<{ ensName?: string; address: string } | null> {
  if (cachedResolution) return cachedResolution;

  const explicit = config.PORTFOLIO_ADDRESS.trim();
  if (explicit) {
    if (!/^0x[a-fA-F0-9]{40}$/i.test(explicit)) {
      console.warn(`[portfolio] PORTFOLIO_ADDRESS "${explicit}" is not a valid 0x address — ignoring it.`);
    } else {
      cachedResolution = { address: explicit.toLowerCase() };
      return cachedResolution;
    }
  }

  const name = config.PORTFOLIO_ENS_NAME.trim();
  if (!name) return null;

  const resolved = await resolveEnsName(name, config.ethRpcUrls);
  if (!resolved) {
    console.warn(`[portfolio] Could not resolve ENS name "${name}" via any configured RPC — /portfolio will report it as unavailable.`);
    return null;
  }

  console.log(`[portfolio] Resolved ${resolved.name} -> ${resolved.address} (READ-ONLY: public address, no key, cannot sign or spend).`);
  cachedResolution = { ensName: resolved.name, address: resolved.address };
  return cachedResolution;
}

/** Test seam — clears the process-lifetime ENS resolution cache. */
export function resetPortfolioAddressCache(): void {
  cachedResolution = null;
}

/**
 * The already-resolved address, without triggering resolution. Used by
 * /status, which must render instantly and must never block on an ENS RPC
 * round-trip; returns null until something has resolved it (startup
 * pre-resolution, or the first /portfolio).
 */
export function getCachedPortfolioAddress(): { ensName?: string; address: string } | null {
  return cachedResolution;
}

function groupByContract(nfts: AccountNft[]): Map<string, AccountNft[]> {
  const grouped = new Map<string, AccountNft[]>();
  for (const nft of nfts) {
    const existing = grouped.get(nft.contract);
    if (existing) existing.push(nft);
    else grouped.set(nft.contract, [nft]);
  }
  return grouped;
}

/**
 * Builds the read-only portfolio snapshot: holdings grouped by collection,
 * each collection's floor (from the same 5-minute-cached read the rest of
 * the agent uses), an estimated value, and a bounded sample of standing
 * offers. Returns null only when no address could be resolved at all.
 */
export async function buildPortfolioSnapshot(): Promise<PortfolioSnapshot | null> {
  const resolution = await resolvePortfolioAddress();
  if (!resolution) return null;

  const nfts = await openseaClient.getNftsByAccount(resolution.address, MAX_ITEMS);
  const ethUsdRate = await openseaClient.getEthUsdRate();
  const grouped = groupByContract(nfts);

  const holdings: PortfolioCollectionHolding[] = [];
  let collectionsMissingFloor = 0;

  for (const [contract, items] of grouped) {
    let floorNative: number | null = null;
    let floorCurrency = "ETH";
    let collectionName = items[0]?.collectionSlug || contract;

    try {
      const floor = await openseaClient.getFloorPrice(contract);
      floorNative = floor.floorPriceNative;
      floorCurrency = floor.floorPriceCurrency;
      collectionName = floor.name || collectionName;
    } catch {
      // Never fabricate a floor — the holding is still listed, just without
      // a value, and the snapshot reports how many are in that state.
      collectionsMissingFloor++;
    }

    holdings.push({
      contract,
      collectionName,
      count: items.length,
      floorNative,
      floorCurrency,
      estimatedValueNative: floorNative !== null ? Number((floorNative * items.length).toFixed(4)) : null,
    });
  }

  // Largest holdings first — that's also the sampling order for offers.
  holdings.sort((a, b) => (b.estimatedValueNative ?? -1) - (a.estimatedValueNative ?? -1) || b.count - a.count);

  // Bounded offers-received sampling: walk holdings largest-first, one token
  // each, until the lookup budget is spent.
  let offersSampled = 0;
  for (const holding of holdings) {
    if (offersSampled >= MAX_OFFER_LOOKUPS) break;
    const token = grouped.get(holding.contract)?.[0];
    if (!token) continue;

    try {
      const best = await openseaClient.getBestOfferForToken(holding.contract, token.tokenId);
      offersSampled++;
      if (best) {
        holding.topOfferNative = best.priceNative;
        holding.topOfferCurrency = best.priceCurrency;
        holding.topOfferTokenId = token.tokenId;
      }
    } catch {
      // A failed offer lookup just leaves that holding without an offer figure.
      offersSampled++;
    }
  }

  const estimatedTotalNative = Number(
    holdings.reduce((sum, h) => sum + (h.estimatedValueNative ?? 0), 0).toFixed(4),
  );

  return {
    ensName: resolution.ensName,
    address: resolution.address,
    totalItems: nfts.length,
    holdings,
    estimatedTotalNative,
    collectionsMissingFloor,
    truncated: nfts.length >= MAX_ITEMS,
    ethUsdRate,
    generatedAt: new Date().toISOString(),
    offersSampled,
  };
}
