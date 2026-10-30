import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SealClient, SessionKey, type KeyServerConfig } from "@mysten/seal";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import { buildPoseidon } from "circomlibjs";
import {
  SealClientDisclosureTransport, disclosureAuthorizationBytes, openDisclosure,
  protocolAgreementCommitment, sealDisclosure, verifyDisclosure, type DisclosurePackage,
} from "../src/audit.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = async <T>(path: string): Promise<T> => JSON.parse(await readFile(resolve(repository, path), "utf8")) as T;
const hex32 = (value: string): string => BigInt(value).toString(16).padStart(64, "0");
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

interface SealConfig {
  packageId: string; module: string; approveFunction: string; threshold: number;
  packagePublishTransaction: string; packagePublishCheckpoint: string; serverConfigs: KeyServerConfig[];
}
interface Phase1Config {
  packageId: string; poolId: string; deploymentDomain: string; coinTypeHash: string; verifierVersion: number;
}
type DecimalRecord = Record<string, string>;

const sealConfig = await load<SealConfig>("config/seal-policy.testnet.json");
const phase1 = await load<Phase1Config>("config/phase1.testnet.json");
const fixture = await load<DecimalRecord>("circuits/build/live-fixtures-append/transfer.json");
const publicValues = await load<DecimalRecord>("circuits/build/live-fixtures-append/public.json");
const transferDigest = "9GkRqDK6RYNEMBs3iEY1aa3HqNhZ6vxQViHTAvBfuGcv";
const endpoint = process.env.SUI_TESTNET_GRPC ?? "https://fullnode.testnet.sui.io:443";
const suiClient = new SuiGrpcClient({ network: "testnet", baseUrl: endpoint });

const chainResult = await suiClient.getTransaction({ digest: transferDigest, include: { effects: true, events: true } });
const chainTransaction = chainResult.Transaction ?? chainResult.FailedTransaction;
assert(chainTransaction, "recorded transfer transaction was not returned by Testnet");
assert.equal(chainTransaction.status.success, true, "recorded transfer did not finalize successfully");
const transferEvent = chainTransaction.events?.find((event) =>
  event.packageId === phase1.packageId && event.eventType === `${phase1.packageId}::pool::TransferEvent`);
assert(transferEvent?.json && typeof transferEvent.json === "object", "recorded transfer event was not found");
const event = transferEvent.json as Record<string, unknown>;
const eventHex = (name: string): string => {
  const encoded = event[name];
  if (typeof encoded !== "string") throw new Error(`transfer event ${name} is missing`);
  return Buffer.from(encoded, "base64").toString("hex");
};
const onchainDealCommitment = eventHex("deal_commitment");
const onchainDealNullifier = eventHex("deal_nullifier");
assert.equal(onchainDealCommitment, hex32(publicValues.dealCommitment!), "fixture deal commitment differs from finalized event");
assert.equal(onchainDealNullifier, hex32(publicValues.dealNullifier!), "fixture deal nullifier differs from finalized event");

const poseidon = await buildPoseidon();
const poseidonHash = (values: bigint[]) => poseidon.F.toObject(poseidon(values));
const limbs = (hex: string): [bigint, bigint] => {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  assert.equal(bytes.length, 32);
  return [BigInt(`0x${bytes.subarray(0, 16).toString("hex")}`), BigInt(`0x${bytes.subarray(16).toString("hex")}`)];
};
const [domainHi, domainLo] = limbs(phase1.deploymentDomain);
const [poolHi, poolLo] = limbs(phase1.poolId);
const [coinHi, coinLo] = limbs(phase1.coinTypeHash);
const deployment = poseidonHash([2100n, domainHi, domainLo, poolHi, poolLo, coinHi, coinLo, BigInt(phase1.verifierVersion)]);

const agreement: Record<string, unknown> = {
  deployment: deployment.toString(), dealId: fixture.dealId, revision: fixture.revision,
  transcriptRootLo: fixture.transcriptRootLo, transcriptRootHi: fixture.transcriptRootHi,
  serviceDigestLo: fixture.serviceDigestLo, serviceDigestHi: fixture.serviceDigestHi,
  settlementNonceLo: fixture.settlementNonceLo, settlementNonceHi: fixture.settlementNonceHi,
  paymentAmount: fixture.paymentAmount, expiry: publicValues.expiry,
  buyerAx: fixture.buyerAx, buyerAy: fixture.buyerAy, sellerAx: fixture.sellerAx, sellerAy: fixture.sellerAy,
  recipientSpendTag: fixture.recipientSpendTag,
};
const agreementOpening = JSON.stringify({ blinding: fixture.blinding });
assert.equal(await protocolAgreementCommitment(agreement, agreementOpening), onchainDealCommitment,
  "disclosed terms and opening do not reproduce the finalized deal commitment");

const auditorKey = Ed25519Keypair.generate();
const outsiderKey = Ed25519Keypair.generate();
const buyerKey = Ed25519Keypair.generate();
const sellerKey = Ed25519Keypair.generate();
const auditor = auditorKey.toSuiAddress();
const outsider = outsiderKey.toSuiAddress();
const buyer = buyerKey.toSuiAddress();
const seller = sellerKey.toSuiAddress();
const unsigned: Omit<DisclosurePackage, "authorizations"> = {
  version: 1,
  dealId: fixture.dealId!,
  auditor,
  agreement,
  agreementOpening,
  transcriptRoot: `${hex32(fixture.transcriptRootLo!)}${hex32(fixture.transcriptRootHi!)}`,
  paymentDigest: transferDigest,
  dealNullifier: onchainDealNullifier,
};
const authorizationBytes = disclosureAuthorizationBytes(unsigned);
const pkg: DisclosurePackage = {
  ...unsigned,
  authorizations: [
    { author: buyer, signature: (await buyerKey.signPersonalMessage(authorizationBytes)).signature },
    { author: seller, signature: (await sellerKey.signPersonalMessage(authorizationBytes)).signature },
  ],
};

const sealClient = new SealClient({ suiClient, serverConfigs: sealConfig.serverConfigs, timeout: 20_000 });
const keys = new Map([[auditor, auditorKey], [outsider, outsiderKey]]);
const transport = new SealClientDisclosureTransport(sealClient, sealConfig.packageId, sealConfig.threshold, async (requester) => {
  const signer = keys.get(requester);
  assert(signer, "no signer exists for requested audit identity");
  const sessionKey = await SessionKey.create({ address: requester, packageId: sealConfig.packageId, ttlMin: 10, signer, suiClient });
  const tx = new Transaction();
  tx.setSender(requester);
  tx.moveCall({
    target: `${sealConfig.packageId}::${sealConfig.module}::${sealConfig.approveFunction}`,
    arguments: [tx.pure.vector("u8", [...Buffer.from(auditor.slice(2), "hex")])],
  });
  return { sessionKey, txBytes: await tx.build({ client: suiClient, onlyTransactionKind: true }) };
});

const ciphertext = await sealDisclosure(pkg, transport);
const opened = await openDisclosure(ciphertext, auditor, transport);
await verifyDisclosure(
  opened, auditor, fixture.dealId!, async (digest) => digest === transferDigest ? {
    finalized: true, paymentDigest: transferDigest, dealNullifier: onchainDealNullifier,
    agreementCommitment: onchainDealCommitment, transcriptRoot: unsigned.transcriptRoot,
  } : undefined,
  (author, bytes, signature) => isValidPersonalMessageSignature(bytes, signature, { address: author }),
  new Set([buyer, seller]), protocolAgreementCommitment,
);

let outsiderRejected = false;
try { await openDisclosure(ciphertext, outsider, transport); } catch { outsiderRejected = true; }
assert(outsiderRejected, "a non-designated auditor decrypted the package");
const tampered = Uint8Array.from(ciphertext);
tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
let tamperRejected = false;
try { await openDisclosure(tampered, auditor, transport); } catch { tamperRejected = true; }
assert(tamperRejected, "tampered ciphertext decrypted successfully");

console.log(JSON.stringify({
  status: "pass",
  network: "testnet",
  policyPackageId: sealConfig.packageId,
  policyPublishTransaction: sealConfig.packagePublishTransaction,
  policyPublishCheckpoint: sealConfig.packagePublishCheckpoint,
  auditor,
  finalizedTransfer: transferDigest,
  dealCommitment: onchainDealCommitment,
  dealNullifier: onchainDealNullifier,
  ciphertextSha256: sha256(ciphertext),
  ciphertextBytes: ciphertext.length,
  threshold: sealConfig.threshold,
  outsiderRejected,
  tamperRejected,
}, null, 2));
