import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import {
  ExactResourceServer, PaymentConsumptionLedger, RoleStore, paymentBindingBytes,
  requirementsHash, verifySuiPaymentBinding, type ExactRequirements, type FinalPayment,
  type PaymentBinding,
} from "../src/index.js";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const envFile = readFileSync(resolve(repository, ".env"), "utf8");
function env(name: string): string {
  const provided = process.env[name];
  if (provided) return provided;
  const line = envFile.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`));
  assert(line, `${name} is required`);
  const raw = line.slice(line.indexOf("=") + 1).trim();
  return raw.length >= 2 && raw[0] === raw[raw.length - 1] && "\"'`".includes(raw[0]!) ? raw.slice(1, -1) : raw;
}
async function jsonFetch(url: string, init?: RequestInit): Promise<{ response: Response; value: unknown }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${new URL(url).pathname} returned non-JSON status ${response.status}`); }
  return { response, value };
}
function object(value: unknown, message: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), message);
  return value as Record<string, unknown>;
}
function decodeHeader(value: string | null, name: string): Record<string, unknown> {
  assert(value, `${name} response header is missing`);
  return object(JSON.parse(Buffer.from(value, "base64").toString("utf8")), `${name} is not an object`);
}
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

const facilitator = env("X402_FACILITATOR_URL").replace(/\/$/, "");
const facilitatorOrigin = new URL(facilitator).origin;
const rpc = process.env.SUI_TESTNET_GRPC ?? "https://fullnode.testnet.sui.io:443";
const suiClient = new SuiGrpcClient({ network: "testnet", baseUrl: rpc });
const decodedKey = decodeSuiPrivateKey(env("SUI_PRIVATE_KEY"));
assert.equal(decodedKey.scheme, "ED25519", "live x402 gate currently requires the configured ED25519 Sui key");
const payerKey = Ed25519Keypair.fromSecretKey(decodedKey.secretKey);
const payer = payerKey.toSuiAddress();

const initial = await fetch(`${facilitator}/signal/whales`, { signal: AbortSignal.timeout(30_000) });
assert.equal(initial.status, 402, "live resource did not return Payment Required");
const required = decodeHeader(initial.headers.get("payment-required"), "PAYMENT-REQUIRED");
await initial.arrayBuffer();
assert.equal(required.x402Version, 2);
const resource = object(required.resource, "x402 resource metadata is missing");
assert.equal(new URL(String(resource.url)).origin, facilitatorOrigin, "resource challenge changed facilitator origin");
assert(Array.isArray(required.accepts) && required.accepts.length > 0, "x402 challenge has no accepted payment kind");
const requirements = object(required.accepts[0], "x402 accepted requirements are missing") as unknown as ExactRequirements;
assert.equal(requirements.scheme, "exact");
assert.equal(requirements.network, "sui:testnet");
assert(/^0x[0-9a-f]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/.test(requirements.asset), "x402 asset is not a Sui coin type");
assert(/^0x[0-9a-f]{64}$/.test(requirements.payTo), "x402 payee is not a Sui address");
assert(BigInt(requirements.amount) > 0n, "x402 amount must be positive");

const supportedResult = await jsonFetch(`${facilitator}/supported`);
assert.equal(supportedResult.response.status, 200);
const supported = object(supportedResult.value, "facilitator capability response is invalid");
assert(Array.isArray(supported.kinds) && supported.kinds.some((entry) => {
  const kind = object(entry, "facilitator payment kind is invalid");
  return kind.x402Version === 2 && kind.scheme === requirements.scheme && kind.network === requirements.network;
}), "facilitator does not advertise the challenged payment kind");

const assetBalance = await suiClient.getBalance({ owner: payer, coinType: requirements.asset });
const gasBalance = await suiClient.getBalance({ owner: payer });
assert(BigInt(assetBalance.balance.balance) >= BigInt(requirements.amount), "payer has insufficient Testnet payment asset");
assert(BigInt(gasBalance.balance.balance) >= 20_000_000n, "payer has insufficient Testnet SUI for gas");

const stateDirectory = mkdtempSync(join(tmpdir(), "supercuts-x402-live-"));
const state = new RoleStore(join(stateDirectory, "resource.sqlite"), randomBytes(32));
try {
  const ledger = new PaymentConsumptionLedger(state);
  let finalizedCheckpoint: string | undefined;
  const readSettlement = async (digest: string): Promise<FinalPayment | undefined> => {
    let result;
    try { result = await suiClient.getTransaction({ digest, include: { effects: true, balanceChanges: true } }); } catch { return undefined; }
    const transaction = result.Transaction ?? result.FailedTransaction;
    if (!transaction?.status.success || transaction.digest !== digest || !transaction.checkpoint) return undefined;
    const credit = transaction.balanceChanges?.find((change) => change.address === requirements.payTo
      && change.coinType === requirements.asset && BigInt(change.amount) > 0n);
    if (!credit) return undefined;
    finalizedCheckpoint = transaction.checkpoint;
    return { digest, network: requirements.network, asset: requirements.asset, amount: BigInt(credit.amount), payTo: requirements.payTo, finalized: true };
  };
  const server = new ExactResourceServer(ledger, requirements, verifySuiPaymentBinding, readSettlement);
  const requestId = `supercuts-live-${Date.now()}-${randomBytes(8).toString("hex")}`;
  const challenge = server.challenge(requestId);

  const tx = new Transaction();
  tx.setSender(payer);
  tx.transferObjects([tx.coin({ balance: BigInt(requirements.amount), type: requirements.asset })], requirements.payTo);
  const transactionBytes = await tx.build({ client: suiClient });
  const transactionDigest = await tx.getDigest({ client: suiClient });
  const transactionSignature = (await payerKey.signTransaction(transactionBytes)).signature;
  const unsignedBinding: Omit<PaymentBinding, "payerSignature"> = {
    requestId,
    nonce: challenge.nonce,
    requirementsHash: requirementsHash(requirements),
    transactionDigest,
    payer,
  };
  const payerSignature = (await payerKey.signPersonalMessage(paymentBindingBytes(unsignedBinding))).signature;
  const binding: PaymentBinding = { ...unsignedBinding, payerSignature };
  assert(await verifySuiPaymentBinding(binding), "locally generated request binding signature is invalid");

  let mutationRejected = false;
  try {
    await server.deliver(requestId, { binding: { ...binding, nonce: `${binding.nonce}00` } }, async () => Buffer.from("must-not-run"));
  } catch (error) { mutationRejected = errorCode(error) === "X402_REQUEST_BINDING_INVALID"; }
  assert(mutationRejected, "mutated request binding was not rejected before settlement");

  const paymentPayload = {
    x402Version: 2,
    resource,
    accepted: requirements,
    payload: { signature: transactionSignature, transaction: Buffer.from(transactionBytes).toString("base64") },
  };
  const facilitatorBody = { x402Version: 2, paymentPayload, paymentRequirements: requirements };
  const verified = await jsonFetch(`${facilitator}/verify`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(facilitatorBody),
  });
  assert.equal(verified.response.status, 200, "facilitator verify request failed");
  assert.equal(object(verified.value, "facilitator verification response is invalid").isValid, true, "facilitator rejected payment before settlement");

  const paidResponse = await fetch(String(resource.url), {
    headers: { "payment-signature": Buffer.from(JSON.stringify(paymentPayload)).toString("base64") },
    signal: AbortSignal.timeout(60_000),
  });
  const paidResource = Buffer.from(await paidResponse.arrayBuffer());
  assert.equal(paidResponse.status, 200, `paid resource returned status ${paidResponse.status}`);
  const settlement = decodeHeader(paidResponse.headers.get("payment-response"), "PAYMENT-RESPONSE");
  assert.equal(settlement.success, true, "resource server reported unsuccessful settlement");
  assert.equal(settlement.transaction, transactionDigest, "resource server settled a different transaction");
  assert.equal(settlement.network, requirements.network, "resource server reported another network");

  await suiClient.waitForTransaction({ digest: transactionDigest, timeout: 30_000 });
  let producerCalls = 0;
  const delivered = await server.deliver(requestId, { binding }, async () => { producerCalls++; return paidResource; });
  const replayed = await server.deliver(requestId, { binding }, async () => { producerCalls++; return Buffer.from("duplicate"); });
  assert(delivered.equals(paidResource) && replayed.equals(paidResource), "resource replay did not return the persisted response");
  assert.equal(producerCalls, 1, "resource producer ran more than once");

  const replayRequestId = `${requestId}-replay`;
  const replayChallenge = server.challenge(replayRequestId);
  const replayUnsigned = { ...unsignedBinding, requestId: replayRequestId, nonce: replayChallenge.nonce };
  const replayBinding: PaymentBinding = {
    ...replayUnsigned,
    payerSignature: (await payerKey.signPersonalMessage(paymentBindingBytes(replayUnsigned))).signature,
  };
  let crossRequestReplayRejected = false;
  try { await server.deliver(replayRequestId, { binding: replayBinding }, async () => Buffer.from("must-not-run")); }
  catch (error) { crossRequestReplayRejected = errorCode(error) === "PAYMENT_CONSUMED"; }
  assert(crossRequestReplayRejected, "settled payment was reusable for another request");
  assert(finalizedCheckpoint, "settlement was not finalized through the chain reader");

  console.log(JSON.stringify({
    status: "pass",
    network: requirements.network,
    facilitator: facilitatorOrigin,
    resource: resource.url,
    requestId,
    requirementsHash: unsignedBinding.requirementsHash,
    bindingSha256: sha256(paymentBindingBytes(unsignedBinding)),
    payer,
    payTo: requirements.payTo,
    asset: requirements.asset,
    amount: requirements.amount,
    transactionDigest,
    checkpoint: finalizedCheckpoint,
    resourceSha256: sha256(delivered),
    resourceBytes: delivered.length,
    mutationRejected,
    sameRequestReplayDeduplicated: producerCalls === 1,
    crossRequestReplayRejected,
  }, null, 2));
} finally {
  state.close();
  rmSync(stateDirectory, { recursive: true, force: true });
}
