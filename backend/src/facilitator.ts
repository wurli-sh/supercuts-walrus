import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { isValidTransactionSignature } from "@mysten/sui/verify";

const NETWORK = "sui:testnet" as const;
const SUI = "0x2::sui::SUI";
type Json = Record<string, unknown>;

/** Sui RPC may expand a type's address to 32 bytes; policy identifiers use its canonical short form. */
function canonicalType(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = /^(0x)([0-9a-f]+)(::.+)$/i.exec(value);
  if (!match) return value;
  return `0x${match[2]!.replace(/^0+/, "") || "0"}${match[3]!}`.toLowerCase();
}

interface SuiClient {
  getTransaction(options: any): Promise<any>;
  simulateTransaction(options: any): Promise<any>;
  executeTransaction(options: any): Promise<any>;
  waitForTransaction(options: any): Promise<any>;
}

interface ParsedPayment { requirements: Json; transaction: Uint8Array; signature: string; digest: string; }

function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Json;
}
function string(value: unknown, label: string, expression?: RegExp): string {
  if (typeof value !== "string" || !value || value.length > 16_384 || (expression && !expression.test(value))) throw new Error(`${label} is invalid`);
  return value;
}
function exactRequirements(value: unknown): Json {
  const requirements = object(value, "paymentRequirements");
  if (requirements.scheme !== "exact" || requirements.network !== NETWORK || requirements.asset !== SUI) throw new Error("only sui:testnet native SUI exact payments are supported");
  string(requirements.payTo, "payTo", /^0x[0-9a-f]{64}$/i);
  string(requirements.amount, "amount", /^[1-9][0-9]*$/);
  if (!Number.isSafeInteger(requirements.maxTimeoutSeconds) || Number(requirements.maxTimeoutSeconds) <= 0) throw new Error("maxTimeoutSeconds is invalid");
  return requirements;
}
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
async function parsePayment(value: unknown, client: SuiClient): Promise<ParsedPayment> {
  const body = object(value, "request");
  if (body.x402Version !== 2) throw new Error("x402Version must be 2");
  const paymentPayload = object(body.paymentPayload, "paymentPayload");
  if (paymentPayload.x402Version !== 2) throw new Error("payment payload x402Version must be 2");
  const requirements = exactRequirements(body.paymentRequirements);
  if (!sameJson(paymentPayload.accepted, requirements)) throw new Error("accepted requirements differ from payment requirements");
  const payload = object(paymentPayload.payload, "payment payload");
  const signature = string(payload.signature, "transaction signature");
  const transactionBase64 = string(payload.transaction, "transaction");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(transactionBase64)) throw new Error("transaction must be base64");
  const transaction = Buffer.from(transactionBase64, "base64");
  if (!transaction.length || transaction.length > 128 * 1024 || Buffer.from(transaction).toString("base64") !== transactionBase64) throw new Error("transaction bytes are invalid");
  if (!(await isValidTransactionSignature(transaction, signature))) throw new Error("transaction signature is invalid");
  let digest: string;
  try { digest = await Transaction.from(transaction).getDigest({ client: client as any }); }
  catch { throw new Error("transaction bytes cannot be decoded"); }
  return { requirements, transaction, signature, digest };
}
function transaction(result: any): any { return result?.Transaction ?? result?.FailedTransaction; }
function assertSuccessfulPayment(result: any, parsed: ParsedPayment, finalized: boolean): void {
  const tx = transaction(result);
  if (!tx) throw new Error("transaction result is missing");
  const digest = tx.digest ?? tx.effects?.transactionDigest;
  if (digest !== parsed.digest) throw new Error("transaction digest differs from the signed bytes");
  if (!tx.status?.success) throw new Error(`transaction did not complete successfully: ${String(tx.status?.error ?? "unknown error")}`);
  if (finalized && !tx.checkpoint) throw new Error("transaction has not finalized");
  const payTo = String(parsed.requirements.payTo), amount = BigInt(String(parsed.requirements.amount));
  const matched = (tx.balanceChanges ?? []).some((change: any) => change.address === payTo && canonicalType(change.coinType) === SUI.toLowerCase() && BigInt(change.amount) === amount);
  if (!matched) throw new Error("transaction does not credit the exact requested native SUI amount");
}

/** Non-custodial x402 v2 facilitator: it validates and relays only buyer-signed Sui bytes. */
export class SuiTestnetFacilitator {
  constructor(private readonly key: string, private readonly client: SuiClient) {
    if (key.length < 24) throw new Error("FACILITATOR_SHARED_KEY must be at least 24 characters");
  }
  private authorized(request: IncomingMessage): boolean {
    const provided = request.headers["x-supercuts-facilitator-key"];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!value) return false;
    const actual = Buffer.from(value), expected = Buffer.from(this.key);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  async verify(value: unknown): Promise<Json> {
    const parsed = await parsePayment(value, this.client);
    let known: any;
    try { known = await this.client.getTransaction({ digest: parsed.digest, include: { effects: true, balanceChanges: true } }); } catch { /* Not finalized yet; simulate the signed transaction. */ }
    if (known) { assertSuccessfulPayment(known, parsed, true); return { isValid: true, network: NETWORK, transaction: parsed.digest, replayed: true }; }
    const simulated = await this.client.simulateTransaction({ transaction: parsed.transaction, include: { effects: true, balanceChanges: true } });
    assertSuccessfulPayment(simulated, parsed, false);
    return { isValid: true, network: NETWORK, transaction: parsed.digest };
  }
  async settle(value: unknown): Promise<Json> {
    const parsed = await parsePayment(value, this.client);
    let known: any;
    try {
      known = await this.client.getTransaction({ digest: parsed.digest, include: { effects: true, balanceChanges: true } });
    } catch { /* The digest has not reached a node yet. */ }
    if (known) {
      assertSuccessfulPayment(known, parsed, true);
      return { success: true, network: NETWORK, transaction: parsed.digest, replayed: true };
    }
    const simulated = await this.client.simulateTransaction({ transaction: parsed.transaction, include: { effects: true, balanceChanges: true } });
    assertSuccessfulPayment(simulated, parsed, false);
    try { await this.client.executeTransaction({ transaction: parsed.transaction, signatures: [parsed.signature], include: { effects: true, balanceChanges: true } }); } catch { /* broadcast may have won a concurrent race */ }
    const finalized = await this.client.waitForTransaction({ digest: parsed.digest, timeout: 60_000, include: { effects: true, balanceChanges: true } });
    assertSuccessfulPayment(finalized, parsed, true);
    return { success: true, network: NETWORK, transaction: parsed.digest };
  }
  createServer(): Server {
    return createServer((request, response) => void this.handle(request, response));
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") return this.send(response, 200, { ok: true, network: NETWORK });
    if (request.method === "GET" && url.pathname === "/supported") return this.send(response, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, asset: SUI }] });
    if (request.method !== "POST" || !["/verify", "/settle"].includes(url.pathname)) return this.send(response, 404, { error: "NOT_FOUND" });
    if (!this.authorized(request)) return this.send(response, 401, { error: "UNAUTHORIZED" });
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 256 * 1024) throw new Error("request too large"); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      this.send(response, 200, url.pathname === "/verify" ? await this.verify(body) : await this.settle(body));
    } catch (error) { this.send(response, 400, { error: "PAYMENT_INVALID", message: error instanceof Error ? error.message : "invalid request" }); }
  }
  private send(response: ServerResponse, status: number, body: Json): void { const encoded = Buffer.from(JSON.stringify(body)); response.writeHead(status, { "content-type": "application/json", "content-length": String(encoded.length) }); response.end(encoded); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const key = process.env.FACILITATOR_SHARED_KEY ?? "";
  const grpc = process.env.SUI_TESTNET_GRPC ?? "https://fullnode.testnet.sui.io:443";
  const port = Number(process.env.PORT ?? "3000");
  const facilitator = new SuiTestnetFacilitator(key, new SuiGrpcClient({ network: "testnet", baseUrl: grpc }));
  facilitator.createServer().listen(port, "0.0.0.0", () => process.stdout.write(`supercuts x402 facilitator listening on ${port}\n`));
}
