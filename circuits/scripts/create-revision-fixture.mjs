import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildEddsa } from "circomlibjs";

const directory = resolve(process.argv[2] ?? "build/adversarial-revision/fixtures");
const config = JSON.parse(readFileSync(resolve(process.argv[3] ?? "build/adversarial-revision/config.json")));
const fixture = JSON.parse(readFileSync(resolve(directory, "transfer.json")));
const recovery = JSON.parse(readFileSync(resolve(directory, "recovery.json")));
const publicValues = JSON.parse(readFileSync(resolve(directory, "public.json")));
const eddsa = await buildEddsa();
const F = eddsa.babyJub.F;
const poseidon = (values) => F.toObject(eddsa.poseidon(values.map(BigInt)));
const limbs = (buffer) => [BigInt(`0x${buffer.subarray(0, 16).toString("hex")}`), BigInt(`0x${buffer.subarray(16).toString("hex")}`)];
const [domainHi, domainLo] = limbs(Buffer.from(config.deploymentDomain, "hex"));
const [poolHi, poolLo] = limbs(Buffer.from(config.poolId.slice(2), "hex"));
const [coinHi, coinLo] = limbs(Buffer.from(config.coinTypeHash, "hex"));
const deployment = poseidon([2100n, domainHi, domainLo, poolHi, poolLo, coinHi, coinLo, BigInt(config.verifierVersion)]);
const revision = 2n;
const termsA = poseidon([2001n, deployment, fixture.dealId, revision, fixture.transcriptRootLo, fixture.transcriptRootHi]);
const termsB = poseidon([fixture.serviceDigestLo, fixture.serviceDigestHi, fixture.settlementNonceLo, fixture.settlementNonceHi, fixture.paymentAmount, publicValues.expiry]);
const termsC = poseidon([fixture.buyerAx, fixture.buyerAy, fixture.sellerAx, fixture.sellerAy, fixture.recipientSpendTag, recovery.paymentSalt]);
const dealCommitment = poseidon([2002n, termsA, termsB, termsC, fixture.blinding, publicValues.expiry]);
const sign = (seed, message) => {
  const sig = eddsa.signPoseidon(Buffer.from(seed, "hex"), F.e(message));
  return { R8x: F.toObject(sig.R8[0]).toString(), R8y: F.toObject(sig.R8[1]).toString(), S: sig.S.toString() };
};
const buyer = sign(recovery.buyerSeed, poseidon([2004n, deployment, dealCommitment]));
const seller = sign(recovery.sellerSeed, poseidon([2005n, deployment, dealCommitment]));
const statement = Buffer.from(fixture.statement);
Buffer.from(dealCommitment.toString(16).padStart(64, "0"), "hex").copy(statement, 106);
const digest = createHash("sha256").update(statement).digest();
const revisionFixture = {
  ...fixture, statement: [...statement], revision: revision.toString(),
  digestHigh: BigInt(`0x${digest.subarray(0, 16).toString("hex")}`).toString(),
  digestLow: BigInt(`0x${digest.subarray(16).toString("hex")}`).toString(),
  buyerR8x: buyer.R8x, buyerR8y: buyer.R8y, buyerS: buyer.S,
  sellerR8x: seller.R8x, sellerR8y: seller.R8y, sellerS: seller.S,
};
writeFileSync(resolve(directory, "transfer-revision2.json"), `${JSON.stringify(revisionFixture, null, 2)}\n`);
writeFileSync(resolve(directory, "public-revision2.json"), `${JSON.stringify({ ...publicValues, dealCommitment: dealCommitment.toString() }, null, 2)}\n`);
console.log(JSON.stringify({ revision: "2", dealCommitment: dealCommitment.toString(), dealNullifier: publicValues.dealNullifier }, null, 2));
