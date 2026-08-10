import { config } from "../config/env.js";
import type { DryRunResult, OrderRequest } from "../types/index.js";

/**
 * Rough on-chain gas estimates per action, in gas units. These are static
 * placeholders (typical mainnet Seaport-style order costs) used only to
 * produce a realistic dry-run readout — not fetched from a live RPC.
 */
const GAS_ESTIMATES: Record<OrderRequest["action"], number> = {
  buy: 150_000,
  list: 90_000,
  bid: 110_000,
  acceptOffer: 140_000,
};

/** Placeholder gas price in gwei, used only for the dry-run cost estimate. */
const ASSUMED_GAS_PRICE_GWEI = 20;

/**
 * The real OpenSea v2 endpoint each action would eventually hit — never
 * called in this version, just surfaced in the dry-run readout so it's
 * clear where live execution would plug in. See src/orders/liveExecution.ts.
 */
const WOULD_SUBMIT_TO: Record<OrderRequest["action"], string> = {
  buy: "OpenSea Seaport fulfillment (fulfill_listing) (NOT called — dry-run only)",
  list: "OpenSea POST /listings (post_listing) (NOT called — dry-run only)",
  bid: "OpenSea POST /offers (post_offer / post_criteria_offer_v2) (NOT called — dry-run only)",
  acceptOffer: "OpenSea Seaport fulfillment (fulfill_offer) (NOT called — dry-run only)",
};

function estimateGasCostNative(gasUnits: number): number {
  const gwei = gasUnits * ASSUMED_GAS_PRICE_GWEI;
  return Number((gwei / 1e9).toFixed(6));
}

function buildSummary(req: OrderRequest): string {
  const currency = req.priceCurrency ?? "ETH";
  switch (req.action) {
    case "buy":
      return `Buy token ${req.tokenId} from collection ${req.collectionId}`;
    case "list":
      return `List token ${req.tokenId} from collection ${req.collectionId} for ${req.priceNative} ${currency}`;
    case "bid":
      return `Place a bid of ${req.priceNative} ${currency} on collection ${req.collectionId}`;
    case "acceptOffer":
      return `Accept offer ${req.offerId} on token ${req.tokenId} from collection ${req.collectionId}`;
  }
}

/**
 * Builds a fully-computed order without ever signing or broadcasting a
 * transaction. This is the ONLY order path implemented in this version —
 * see src/orders/liveExecution.ts for the disabled live-execution stub.
 */
export function buildDryRunOrder(req: OrderRequest): DryRunResult {
  const gasUnits = GAS_ESTIMATES[req.action];

  return {
    dryRun: true,
    action: req.action,
    summary: buildSummary(req),
    params: {
      action: req.action,
      collectionId: req.collectionId,
      tokenId: req.tokenId,
      priceNative: req.priceNative,
      priceCurrency: req.priceCurrency ?? "ETH",
      offerId: req.offerId,
      chain: config.CHAIN_NAME,
      chainId: config.CHAIN_ID,
      walletAddress: config.WALLET_ADDRESS || "(not configured)",
      requestedBy: req.requestedBy ?? "unspecified",
    },
    estimatedGasUnits: gasUnits,
    estimatedGasCostNative: estimateGasCostNative(gasUnits),
    gasCurrency: config.CHAIN_NAME === "ethereum" ? "ETH" : "native token",
    wouldSubmitTo: WOULD_SUBMIT_TO[req.action],
    timestamp: new Date().toISOString(),
  };
}
