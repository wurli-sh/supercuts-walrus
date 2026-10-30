import { fail } from "./errors.js";

export type MemoryFactKind = "budget_preference" | "counterparty_reliability" | "delivery_observation" | "successful_counteroffer" | "privacy_choice";
export interface MemoryFact { kind: MemoryFactKind; subject: string; observation: string; operationId: string; createdAt: number; }
const forbidden = [/private key/i, /spend secret/i, /note opening/i, /full transcript/i, /seed phrase/i];
export function validateMemoryFact(fact: MemoryFact): void {
  if (!fact.subject || !fact.observation || !fact.operationId) fail("MEMORY_FACT_INVALID", "memory facts require subject, observation, and operation ID");
  if (!Number.isSafeInteger(fact.createdAt) || fact.createdAt < 0 || fact.subject.length > 256 || fact.observation.length > 4096 || fact.operationId.length > 256) fail("MEMORY_FACT_INVALID", "memory fact timestamp or field length is invalid");
  if (forbidden.some((pattern) => pattern.test(`${fact.subject}\n${fact.observation}`))) fail("MEMORY_SECRET_REJECTED", "memory facts cannot include wallet or transcript secrets");
}
export interface RailPolicy { hiddenAmountRequired: boolean; recalledRulesAvailable: boolean; contradictory: boolean; }
export function selectRail(policy: RailPolicy, requested: "shielded" | "x402"): "shielded" | "x402" {
  if (!policy.recalledRulesAvailable || policy.contradictory) fail("POLICY_RECALL_REQUIRED", "payment requires explicit policy because recall is missing or contradictory");
  if (requested === "x402" && policy.hiddenAmountRequired) fail("PUBLIC_RAIL_FORBIDDEN", "policy requires a hidden payment amount");
  return requested;
}
