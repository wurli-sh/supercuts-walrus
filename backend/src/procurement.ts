import { fail } from "./errors.js";

export interface NegotiationBounds { buyerOffer: bigint; buyerMaximum: bigint; sellerMinimum: bigint; }

/** Amounts are backend-owned; the model can only choose whether to continue with this result. */
export function deterministicCounteroffer(bounds: NegotiationBounds): bigint {
  const { buyerOffer, buyerMaximum, sellerMinimum } = bounds;
  if (buyerOffer < 0n || buyerMaximum <= 0n || sellerMinimum <= 0n || buyerOffer > buyerMaximum) fail("NEGOTIATION_BOUNDS_INVALID", "negotiation amounts are invalid");
  if (sellerMinimum > buyerMaximum) fail("NEGOTIATION_NO_OVERLAP", "seller minimum exceeds buyer maximum");
  if (buyerOffer >= sellerMinimum) return buyerOffer;
  const midpoint = buyerOffer + (sellerMinimum - buyerOffer + 1n) / 2n;
  return midpoint < sellerMinimum ? sellerMinimum : midpoint > buyerMaximum ? buyerMaximum : midpoint;
}

export function settlementRailForPrivacy(privacy: "public" | "confidential", supported: ReadonlyArray<"x402" | "shielded">): "x402" | "shielded" {
  const wanted = privacy === "confidential" ? "shielded" : "x402";
  if (!supported.includes(wanted)) fail("RAIL_UNAVAILABLE", `${wanted} is required by deterministic privacy policy but is unavailable`);
  return wanted;
}
