import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.js";
import type { Phase3App, Role } from "./phase3.js";

export interface AgentMandate {
  version: "supercuts.mandate.v1";
  owner: string;
  role: Role;
  allowedCommands: string[];
  allowedCounterparties: string[];
  allowedAssets: string[];
  perDealCeiling: string;
  totalRunBudget: string;
  requiredPrivacy: "any" | "shielded";
  expiresAt: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: { type: "object"; properties: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties: false };
}

const string = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", minLength: 1, description, ...extra });
const boolean = (description: string) => ({ type: "boolean", description });
const object = (properties: Record<string, Record<string, unknown>>, required: string[] = [], mutating = false, description = "") => ({ properties: { ...properties, ...(mutating ? { "operation-id": string("Stable idempotency identity for this exact mutation.", { maxLength: 256 }) } : {}) }, required: [...required, ...(mutating ? ["operation-id"] : [])], mutating, description });
const definitions: Record<string, ReturnType<typeof object>> = {
  status: object({}, [], false, "Read this isolated agent's public runtime status."),
  doctor: object({}, [], false, "Verify pinned deployment, artifacts, identities, and configured services."),
  "capability.discover": object({ capabilities: { type: "array", description: "Validated supercuts.capability.v1 manifests.", items: { type: "object" } }, "blob-ids": { type: "array", description: "Walrus blob IDs containing capability manifests.", items: { type: "string" } } }, [], false, "Discover seller capabilities without assuming an agent framework."),
  "capability.publish": object({ manifest: { type: "object", description: "A complete supercuts.capability.v1 manifest." } }, ["manifest"], true, "Publish an owner-approved, versioned capability manifest."),
  "wallet.deposit": object({ amount: string("Unsigned base-unit amount.", { pattern: "^[1-9][0-9]*$" }) }, ["amount"], true, "Deposit funds into the shielded pool."),
  "wallet.balance": object({}, [], false, "Read event-derived private-note balance."),
  "wallet.recover": object({ commitment: string("Optional payment-note commitment."), amount: string("Optional matching amount.", { pattern: "^[1-9][0-9]*$" }) }, [], true, "Recover notes from pinned finalized pool events."),
  "wallet.withdraw": object({ commitment: string("Note commitment to spend."), recipient: string("Sui recipient address.") }, ["commitment"], true, "Withdraw one owned shielded note."),
  "offer.open": object({ session: string("Optional stable negotiation session ID.") }, [], true, "Open a durable negotiation session."),
  "offer.propose": object({ session: string("Negotiation session ID."), revision: string("Positive revision.", { pattern: "^[1-9][0-9]*$" }), terms: string("Plain-language or canonical JSON terms.") }, ["session", "revision", "terms"], true, "Submit an offer revision."),
  "offer.counter": object({ session: string("Negotiation session ID."), revision: string("Positive revision.", { pattern: "^[1-9][0-9]*$" }), terms: string("Plain-language or canonical JSON terms."), agreement: string("Backend-only encoded agreement draft.") }, ["session"], true, "Counter an offer under deterministic price policy."),
  "offer.accept": object({ session: string("Negotiation session ID."), revision: string("Positive revision.", { pattern: "^[1-9][0-9]*$" }), terms: string("Accepted terms."), agreement: string("Backend-only encoded signed agreement.") }, ["session"], true, "Accept policy-approved final terms."),
  "offer.show": object({ session: string("Negotiation session ID.") }, ["session"], false, "Read the latest durable offer revision."),
  "pay.quote": object({ rail: string("Requested settlement rail.", { enum: ["x402", "shielded"] }), amount: string("Unsigned base-unit amount.", { pattern: "^[1-9][0-9]*$" }), counterparty: string("Mandate-approved payee."), asset: string("Sui coin type.") }, ["rail", "amount", "counterparty"], false, "Evaluate payment policy without signing."),
  "pay.shielded": object({ session: string("Accepted agreement session."), amount: string("Unsigned base-unit amount.", { pattern: "^[1-9][0-9]*$" }), counterparty: string("Mandate-approved seller."), asset: string("Sui coin type."), "request-id": string("Bound delivery request ID."), "broadcast-only": boolean("Stop after broadcast for recovery testing.") }, [], true, "Settle one accepted agreement through the experimental shielded pool."),
  "pay.x402": object({ "resource-url": string("Seller-owned protected resource URL."), amount: string("Unsigned base-unit amount.", { pattern: "^[1-9][0-9]*$" }), counterparty: string("Mandate-approved public payee."), asset: string("Sui coin type."), "request-id": string("Bound delivery request ID."), "broadcast-only": boolean("Stop after broadcast for recovery testing.") }, [], true, "Complete a standard x402 v2 exact Sui payment challenge."),
  "pay.status": object({ "operation-id": string("Payment operation identity."), reconcile: boolean("Reconcile an ambiguous broadcast.") }, ["operation-id"], false, "Read or reconcile a previously journaled payment."),
  "resource.serve": object({ "request-id": string("Unique request identity."), body: string("Base64-encoded artifact bytes.") }, ["request-id", "body"], true, "Bind one generated artifact to one request."),
  "resource.fetch": object({ "request-id": string("Bound request identity."), "operation-id": string("Finalized payment operation."), response: string("Base64-encoded paid response.") }, ["request-id", "operation-id", "response"], false, "Record delivery separately from payment evidence."),
  "memory.remember": object({ fact: string("Sanitized durable fact, never a secret or full transcript.", { maxLength: 4096 }) }, ["fact"], true, "Write one meaningful Mainnet Walrus memory fact."),
  "memory.recall": object({ query: string("Policy or experience query.", { maxLength: 1024 }) }, ["query"], false, "Recall relevant prior experience and privacy rules."),
  "memory.status": object({}, [], false, "List completed memory blob identities."),
  disclose: object({ "deal-id": string("Deal scope."), auditor: string("Designated auditor identity."), "payment-digest": string("Finalized payment digest."), "transcript-root": string("Authenticated agreement transcript root.") }, ["deal-id", "auditor", "payment-digest", "transcript-root"], true, "Create a deal- and auditor-scoped disclosure package."),
  "audit.verify": object({ package: string("Seal ciphertext or mock disclosure package."), auditor: string("This auditor identity."), "deal-id": string("Exact deal scope.") }, ["package", "auditor", "deal-id"], false, "Verify agreement and payment only; delivery remains a separate observation."),
};

export function toolSchema(name: string): ToolSchema {
  const definition = definitions[name] ?? fail("COMMAND_UNKNOWN", `unknown MCP tool ${name}`);
  return { name, description: definition.description, mutating: definition.mutating, inputSchema: { type: "object", properties: definition.properties, ...(definition.required.length ? { required: definition.required } : {}), additionalProperties: false } };
}

function validateValue(name: string, schema: Record<string, unknown>, value: unknown): void {
  if (schema.type === "string" && typeof value !== "string") fail("MCP_ARGUMENT_INVALID", `${name} must be a string`);
  if (schema.type === "boolean" && typeof value !== "boolean") fail("MCP_ARGUMENT_INVALID", `${name} must be a boolean`);
  if (schema.type === "array" && !Array.isArray(value)) fail("MCP_ARGUMENT_INVALID", `${name} must be an array`);
  if (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) fail("MCP_ARGUMENT_INVALID", `${name} must be an object`);
  if (typeof value === "string" && typeof schema.pattern === "string" && !(new RegExp(schema.pattern).test(value))) fail("MCP_ARGUMENT_INVALID", `${name} has an invalid format`);
  if (typeof value === "string" && Array.isArray(schema.enum) && !schema.enum.includes(value)) fail("MCP_ARGUMENT_INVALID", `${name} is not an allowed value`);
}

export function validateToolArguments(spec: ToolSchema, raw: Record<string, unknown>): void {
  for (const name of Object.keys(raw)) if (!(name in spec.inputSchema.properties)) fail("MCP_ARGUMENT_UNKNOWN", `${spec.name} does not accept ${name}`);
  for (const name of spec.inputSchema.required ?? []) if (!(name in raw)) fail("MCP_ARGUMENT_REQUIRED", `${spec.name} requires ${name}`);
  for (const [name, value] of Object.entries(raw)) validateValue(name, spec.inputSchema.properties[name]!, value);
}

export function loadMandate(home: string): AgentMandate {
  const path = join(home, "mandate.json");
  if (!existsSync(path)) fail("MANDATE_NOT_FOUND", "MCP requires an owner-issued mandate.json");
  if ((statSync(path).mode & 0o077) !== 0) fail("MANDATE_PERMISSIONS", "mandate.json must be owner-only");
  let mandate: AgentMandate; try { mandate = JSON.parse(readFileSync(path, "utf8")) as AgentMandate; } catch (error) { return fail("MANDATE_INVALID", "mandate.json is not valid JSON", error); }
  if (mandate.version !== "supercuts.mandate.v1" || !mandate.owner || !Array.isArray(mandate.allowedCommands) || !Array.isArray(mandate.allowedCounterparties) || !Array.isArray(mandate.allowedAssets) || !/^(?:0|[1-9][0-9]*)$/.test(mandate.perDealCeiling) || !/^(?:0|[1-9][0-9]*)$/.test(mandate.totalRunBudget) || !Number.isSafeInteger(mandate.expiresAt)) fail("MANDATE_INVALID", "mandate.json has an invalid shape");
  return mandate;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Turns an allowed MCP invocation into a backend exact-intent approval without exposing its token. */
export async function executeMandated(app: Phase3App, mandate: AgentMandate, command: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const spec = toolSchema(command); validateToolArguments(spec, raw);
  if (mandate.role !== app.profile.role || Date.now() > mandate.expiresAt) fail(Date.now() > mandate.expiresAt ? "MANDATE_EXPIRED" : "MANDATE_ROLE_MISMATCH", "owner mandate does not authorize this agent");
  if (!mandate.allowedCommands.includes(command)) fail("MANDATE_COMMAND_FORBIDDEN", `mandate does not allow ${command}`);
  const args: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(raw)) args[key] = typeof value === "boolean" ? value : typeof value === "string" ? value : Buffer.from(JSON.stringify(value)).toString("base64url");
  if (!spec.mutating) return (await app.execute(command, args)).data;
  const operationId = String(raw["operation-id"]), amount = typeof raw.amount === "string" ? BigInt(raw.amount) : 0n;
  if (amount > BigInt(mandate.perDealCeiling)) fail("MANDATE_DEAL_CEILING_EXCEEDED", "operation exceeds the owner mandate per-deal ceiling");
  if (typeof raw.counterparty === "string" && !mandate.allowedCounterparties.includes(raw.counterparty)) fail("MANDATE_COUNTERPARTY_FORBIDDEN", "counterparty is outside the owner mandate");
  if (typeof raw.asset === "string" && !mandate.allowedAssets.includes(raw.asset)) fail("MANDATE_ASSET_FORBIDDEN", "asset is outside the owner mandate");
  if (mandate.requiredPrivacy === "shielded" && command === "pay.x402") fail("MANDATE_PRIVACY_REQUIRED", "owner mandate requires shielded settlement");
  const intentHash = createHash("sha256").update(canonical({ command, raw })).digest("hex");
  app.store.db.exec("CREATE TABLE IF NOT EXISTS mandate_operations(operation_id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,amount TEXT NOT NULL,created_at INTEGER NOT NULL)");
  app.store.db.exec("BEGIN IMMEDIATE");
  try {
    const existing = app.store.db.prepare("SELECT intent_hash FROM mandate_operations WHERE operation_id=?").get(operationId) as { intent_hash: string } | undefined;
    if (existing && existing.intent_hash !== intentHash) fail("OPERATION_ID_CONFLICT", "operation ID already identifies another mandated mutation");
    const spent = (app.store.db.prepare("SELECT amount FROM mandate_operations").all() as Array<{ amount: string }>).reduce((sum, row) => sum + BigInt(row.amount), 0n);
    if (!existing && spent + amount > BigInt(mandate.totalRunBudget)) fail("MANDATE_RUN_BUDGET_EXCEEDED", "operation exceeds the owner mandate total run budget");
    if (!existing) app.store.db.prepare("INSERT INTO mandate_operations(operation_id,intent_hash,amount,created_at) VALUES(?,?,?,?)").run(operationId, intentHash, amount.toString(), Date.now());
    app.store.db.exec("COMMIT");
  } catch (error) { app.store.db.exec("ROLLBACK"); throw error; }
  // Keep the reservation on every failure: a thrown transport error can occur
  // after signing or broadcast, so releasing budget here could authorize a
  // second payment. Exact retries reconcile this same operation identity.
  const preview = app.preview(command, args), approval = app.approve(preview.challengeId);
  return (await app.execute(command, { ...args, "approval-token": approval.token })).data;
}
