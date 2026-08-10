import { z } from "zod";
import { config } from "../config/env.js";
import type { DryRunResult, OrderRequest } from "../types/index.js";
import { buildDryRunOrder } from "./dryRun.js";

const orderRequestSchema = z
  .object({
    action: z.enum(["buy", "list", "bid", "acceptOffer"]),
    collectionId: z.string().min(1, "collectionId is required"),
    tokenId: z.string().optional(),
    priceNative: z.number().positive().optional(),
    priceCurrency: z.string().optional(),
    offerId: z.string().optional(),
    requestedBy: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.action === "buy" || val.action === "acceptOffer") && !val.tokenId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tokenId"], message: `tokenId is required for action "${val.action}"` });
    }
    if (val.action === "list" && !val.tokenId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tokenId"], message: `tokenId is required for action "list"` });
    }
    if ((val.action === "list" || val.action === "bid") && val.priceNative === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["priceNative"], message: `priceNative is required for action "${val.action}"` });
    }
    if (val.action === "acceptOffer" && !val.offerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offerId"], message: `offerId is required for action "acceptOffer"` });
    }
  });

export interface OrderIntakeResult {
  ok: boolean;
  errors?: string[];
  dryRun?: DryRunResult;
}

/**
 * Public entry point for "accept orders": validates an incoming order
 * request object and routes it to the dry-run order builder. This is the
 * only order path in this version — see src/orders/liveExecution.ts.
 */
export function submitOrderRequest(raw: unknown): OrderIntakeResult {
  const parsed = orderRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  if (!config.DRY_RUN) {
    // Guard belt-and-suspenders: even if DRY_RUN were flipped, this build
    // has no implemented live path (see liveExecution.ts), so we refuse
    // rather than silently no-op.
    return {
      ok: false,
      errors: ["DRY_RUN is false, but live execution is not implemented in this version. Refusing to proceed."],
    };
  }

  const req = parsed.data as OrderRequest;
  const dryRun = buildDryRunOrder(req);
  return { ok: true, dryRun };
}
