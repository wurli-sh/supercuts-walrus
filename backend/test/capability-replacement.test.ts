import assert from "node:assert/strict";
import test from "node:test";
import { assertCapabilityReplaceable } from "../src/seller-runtime.js";

const registration = (manifestHash: string, expiresAt: number, sellerId = "0xseller", capabilityId = "cap") => ({ manifest: { manifestHash, expiresAt, sellerId, capabilityId } }) as never;

test("an active capability keeps its signed terms; same terms, expired terms, or a new capability may proceed", () => {
  const now = 1_000;
  assert.doesNotThrow(() => assertCapabilityReplaceable(undefined, registration("b", 5_000), now), "new capability");
  assert.doesNotThrow(() => assertCapabilityReplaceable(registration("a", 5_000), registration("a", 5_000), now), "identical terms");
  assert.doesNotThrow(() => assertCapabilityReplaceable(registration("a", 900), registration("b", 5_000), now), "renewal after expiry");
  assert.throws(() => assertCapabilityReplaceable(registration("a", 5_000), registration("b", 9_000), now), (error: Error & { code?: string }) => error.code === "SELLER_CAPABILITY_CONFLICT" && /new capability ID|expires/.test(error.message));
  assert.throws(() => assertCapabilityReplaceable(registration("a", 900, "0xother"), registration("b", 5_000), now), { code: "SELLER_CAPABILITY_CONFLICT" });
});
