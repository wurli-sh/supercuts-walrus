import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { fail, SupercutsError } from "./errors.js";
import type { RoleStore } from "./store.js";
import { paymentBindingBytes, PaymentConsumptionLedger, requirementsHash, verifyBinding, verifyExactPayment, type ExactRequirements, type PaymentBinding } from "./x402.js";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";

export interface X402ResourceServiceConfig {
  origin: string;
  pathPrefix?: string;
  facilitatorUrl: string;
  /** Owner-only credential for the facilitator. Never put this in a manifest or buyer profile. */
  facilitatorKey: string;
  network: "sui:testnet";
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds?: number;
}

interface RegisteredArtifact { requestId: string; operationId: string; body: Buffer; }
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
function decode(value: string | undefined, code: string): Record<string, any> {
  const encoded = value ?? fail(code, "required x402 header is missing");
  try { const parsed = JSON.parse(Buffer.from(encoded, "base64").toString()); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(code, "x402 header must encode an object"); return parsed as Record<string, any>; }
  catch (error) { return fail(code, "x402 header is not valid base64 JSON", error); }
}
function safeUrl(value: string): URL { try { return new URL(value); } catch (error) { return fail("X402_CONFIG_INVALID", "x402 service URL is invalid", error); } }

/** Seller-owned standard x402 v2 exact resource with additional request-binding replay protection. */
export class X402ResourceService {
  readonly #ledger: PaymentConsumptionLedger;
  readonly #artifacts = new Map<string, RegisteredArtifact>();
  readonly #origin: URL;
  readonly #facilitator: URL;
  readonly #prefix: string;
  constructor(store: RoleStore, readonly config: X402ResourceServiceConfig, private readonly http: typeof fetch = fetch) {
    this.#ledger = new PaymentConsumptionLedger(store); this.#origin = safeUrl(config.origin); this.#facilitator = safeUrl(config.facilitatorUrl);
    this.#prefix = (config.pathPrefix ?? "/research").replace(/\/$/, "");
    if (this.#origin.protocol !== "https:" && !(this.#origin.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(this.#origin.hostname))) fail("X402_CONFIG_INVALID", "resource origin must use HTTPS except on loopback");
    if (this.#facilitator.protocol !== "https:" && !(this.#facilitator.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(this.#facilitator.hostname))) fail("X402_CONFIG_INVALID", "facilitator must use HTTPS except on loopback");
    if (!/^0x[0-9a-f]{64}$/i.test(config.payTo) || !/^0x[0-9a-f]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/.test(config.asset) || !/^[1-9][0-9]*$/.test(config.amount)) fail("X402_CONFIG_INVALID", "payTo, asset, or amount is invalid");
    if (!config.facilitatorKey || config.facilitatorKey.length < 24 || config.facilitatorKey.length > 1024) fail("X402_CONFIG_INVALID", "facilitatorKey must be an owner-only secret");
  }
  register(requestId: string, operationId: string, body: Uint8Array): { url: string; artifactSha256: string } {
    if (!requestId || !operationId || requestId.length > 256 || operationId.length > 256 || !body.length || body.length > 10 * 1024 * 1024) fail("RESOURCE_INVALID", "artifact registration is invalid");
    const existing = this.#artifacts.get(requestId), next = Buffer.from(body);
    if (existing && (existing.operationId !== operationId || !existing.body.equals(next))) fail("RESOURCE_REQUEST_CONFLICT", "request already identifies another artifact or operation");
    this.#artifacts.set(requestId, { requestId, operationId, body: next });
    return { url: new URL(`${this.#prefix}/${encodeURIComponent(requestId)}`, this.#origin).toString(), artifactSha256: (awaitHash(next)) };
  }
  private requirements(artifact: RegisteredArtifact): ExactRequirements {
    return { scheme: "exact", network: this.config.network, amount: this.config.amount, asset: this.config.asset, payTo: this.config.payTo, maxTimeoutSeconds: this.config.maxTimeoutSeconds ?? 300, extra: { requestId: artifact.requestId, operationId: artifact.operationId } };
  }
  private resourceUrl(requestId: string): string { return new URL(`${this.#prefix}/${encodeURIComponent(requestId)}`, this.#origin).toString(); }
  private challenge(artifact: RegisteredArtifact): Record<string, unknown> {
    // The live Sui exact facilitator requires the x402 nonce to be exactly
    // 32 random bytes (hex encoded), not merely an application nonce.
    const requirements = this.requirements(artifact), nonce = this.#ledger.challenge(artifact.requestId, requirementsHash(requirements), () => randomBytes(32).toString("hex"));
    requirements.extra = { ...requirements.extra, nonce };
    // The nonce changes the signed requirement set and is persisted per request.
    const finalHash = requirementsHash(requirements);
    return { x402Version: 2, resource: { url: this.resourceUrl(artifact.requestId), description: "Supercuts seller research artifact", mimeType: "application/json" }, accepts: [{ ...requirements, extra: { ...requirements.extra, requirementsHash: finalHash } }] };
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "GET") return this.send(response, 405, Buffer.from("Method Not Allowed"), { allow: "GET" });
      const url = new URL(request.url ?? "/", this.#origin), prefix = `${this.#prefix}/`;
      if (!url.pathname.startsWith(prefix)) return this.send(response, 404, Buffer.from("Not Found"));
      const requestId = decodeURIComponent(url.pathname.slice(prefix.length)), artifact = this.#artifacts.get(requestId);
      if (!artifact) return this.send(response, 404, Buffer.from("Not Found"));
      const challenge = this.challenge(artifact), requirements = challenge.accepts instanceof Array ? challenge.accepts[0] as ExactRequirements : fail("X402_STATE_INVALID", "challenge omitted requirements");
      const paymentHeader = Array.isArray(request.headers["payment-signature"]) ? request.headers["payment-signature"][0] : request.headers["payment-signature"];
      if (!paymentHeader) return this.send(response, 402, Buffer.from("Payment Required"), { "payment-required": encode(challenge) });
      const payload = decode(paymentHeader, "X402_PAYMENT_INVALID"), bindingValue = Array.isArray(request.headers["x-supercuts-binding"]) ? request.headers["x-supercuts-binding"][0] : request.headers["x-supercuts-binding"], binding = decode(bindingValue, "X402_REQUEST_BINDING_INVALID") as unknown as PaymentBinding;
      const offered = payload.accepted as ExactRequirements;
      if (!offered || requirementsHash(offered) !== requirementsHash(requirements)) fail("X402_REQUIREMENTS_MISMATCH", "payment payload changed the challenged requirements");
      const extra = requirements.extra as Record<string, unknown>, nonce = String(extra.nonce ?? ""), declaredHash = String(extra.requirementsHash ?? "");
      const unsignedRequirements = { ...requirements, extra: { requestId: extra.requestId, operationId: extra.operationId, nonce } };
      if (declaredHash !== requirementsHash(unsignedRequirements)) fail("X402_REQUIREMENTS_MISMATCH", "challenge requirements hash is invalid");
      verifyBinding(binding, artifact.requestId, nonce, unsignedRequirements, binding.transactionDigest);
      const { payerSignature: _signature, ...unsignedBinding } = binding;
      if (!(await isValidPersonalMessageSignature(paymentBindingBytes(unsignedBinding), binding.payerSignature, { address: binding.payer }))) fail("X402_PAYER_SIGNATURE_INVALID", "payer did not bind payment to this resource request");
      const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };
      const verified = await this.facilitator("verify", body);
      if (verified.isValid !== true) fail("X402_FACILITATOR_REJECTED", "facilitator rejected the signed payment");
      const settled = await this.facilitator("settle", body), digest = String(settled.transaction ?? "");
      if (settled.success !== true || settled.network !== this.config.network || digest !== binding.transactionDigest) fail("X402_SETTLEMENT_INVALID", "facilitator returned mismatched settlement evidence");
      const payment = { digest, network: this.config.network, asset: this.config.asset, amount: BigInt(this.config.amount), payTo: this.config.payTo, finalized: true };
      verifyExactPayment(payment, requirements); this.#ledger.claim(payment, artifact.requestId);
      let delivery = this.#ledger.getDelivery(artifact.requestId);
      if (!this.#ledger.isDeliveryComplete(artifact.requestId)) {
        if (!this.#ledger.acquireDelivery(artifact.requestId)) fail("DELIVERY_IN_PROGRESS", "resource delivery is already being produced");
        this.#ledger.completeDelivery(artifact.requestId, artifact.body);
        delivery = artifact.body;
      }
      return this.send(response, 200, delivery ?? fail("DELIVERY_STATE_INVALID", "completed delivery has no bytes"), { "content-type": "application/json", "payment-response": encode({ success: true, transaction: digest, network: this.config.network }) });
    } catch (error) {
      const known = error instanceof SupercutsError ? error : new SupercutsError("INTERNAL_ERROR", "resource service failed");
      return this.send(response, known.code === "PAYMENT_CONSUMED" ? 409 : 400, Buffer.from(JSON.stringify({ error: known.code })) , { "content-type": "application/json" });
    }
  }
  createServer(): Server { return createServer((request, response) => void this.handle(request, response)); }
  private async facilitator(path: "verify" | "settle", body: unknown): Promise<Record<string, any>> {
    const endpoint = new URL(path, `${this.#facilitator.toString().replace(/\/$/, "")}/`);
    const response = await this.http(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-supercuts-facilitator-key": this.config.facilitatorKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    let value: unknown; try { value = await response.json(); } catch (error) { return fail("X402_FACILITATOR_INVALID", "facilitator returned invalid JSON", error); }
    if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) fail("X402_FACILITATOR_INVALID", `facilitator ${path} failed with ${response.status}`);
    return value as Record<string, any>;
  }
  private send(response: ServerResponse, status: number, body: Buffer, headers: Record<string, string> = {}): void { response.writeHead(status, { "content-length": String(body.length), ...headers }); response.end(body); }
}

import { createHash } from "node:crypto";
function awaitHash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
