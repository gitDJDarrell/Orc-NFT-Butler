import type { DryRunResult, OrderRequest } from "../types/index.js";

/**
 * DISABLED — live transaction signing/broadcasting.
 *
 * This is intentionally not implemented. This version of the agent must
 * never sign or send a real transaction. When live execution is built,
 * it belongs here, gated behind:
 *   1. config.DRY_RUN === false (explicit opt-in in .env)
 *   2. An explicit interactive confirmation from the operator for the
 *      specific order (price, token, action) being executed
 *   3. A real wallet/signer (e.g. viem/ethers Wallet backed by a private
 *      key or hardware signer) that is NEVER read from a plain .env value
 *   4. OpenSea's real order endpoints — POST /offers (post_offer /
 *      post_criteria_offer_v2) for bids, POST /listings (post_listing) for
 *      listings — to obtain signable Seaport order parameters, followed by
 *      signing (EIP-712) and, for fulfilling an existing listing/offer,
 *      Seaport contract fulfillment (fulfillBasicOrder / fulfillOrder via
 *      the Seaport SDK) to actually broadcast the transaction
 *
 * Until all of that exists, calling this function always throws so it can
 * never be wired in accidentally.
 */
export async function executeOrderLive(_req: OrderRequest, _dryRunPreview: DryRunResult): Promise<never> {
  throw new Error(
    "Live order execution is not implemented in this version. " +
      "The agent only supports dry-run order building (see src/orders/dryRun.ts). " +
      "DRY_RUN must stay true; there is no code path here that signs or broadcasts a transaction.",
  );
}
