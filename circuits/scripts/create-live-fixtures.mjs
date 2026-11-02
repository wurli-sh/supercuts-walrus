import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEddsa } from "circomlibjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const append = process.argv.slice(2).includes("--append");
const output = process.env.LIVE_FIXTURE_DIR
  ? resolve(repository, process.env.LIVE_FIXTURE_DIR)
  : resolve(root, append ? "build/live-fixtures-append" : "build/live-fixtures");
const config = JSON.parse(readFileSync(process.env.PHASE1_CONFIG
  ? resolve(repository, process.env.PHASE1_CONFIG)
  : resolve(repository, "config/pool-v1.testnet.json")));
const scalar = (bits = 248) => {
  const value = BigInt(`0x${randomBytes(Math.ceil(bits / 8)).toString("hex")}`) & ((1n << BigInt(bits)) - 1n);
  return value || 1n;
};
const fieldBytes = (value) => Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex");
const u32 = (value) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
const u64 = (value) => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; };
const limbs = (buffer) => [BigInt(`0x${buffer.subarray(0, 16).toString("hex")}`), BigInt(`0x${buffer.subarray(16).toString("hex")}`)];
const asJson = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
const digestInputs = (statement) => {
  const digest = createHash("sha256").update(statement).digest();
  return {
    digestHigh: BigInt(`0x${digest.subarray(0, 16).toString("hex")}`).toString(),
    digestLow: BigInt(`0x${digest.subarray(16).toString("hex")}`).toString(),
  };
};

function tree(poseidon, leaves, selectedIndex) {
  const zero = [0n];
  for (let level = 0; level < 20; level++) zero.push(poseidon([zero[level], zero[level]]));
  let nodes = new Map(leaves.map((leaf, index) => [index, leaf]));
  let index = selectedIndex;
  const pathElements = [];
  for (let level = 0; level < 20; level++) {
    pathElements.push(nodes.get(index ^ 1) ?? zero[level]);
    const parents = new Map();
    for (const position of nodes.keys()) {
      const parent = Math.floor(position / 2);
      if (!parents.has(parent)) parents.set(parent, poseidon([
        nodes.get(parent * 2) ?? zero[level], nodes.get(parent * 2 + 1) ?? zero[level],
      ]));
    }
    nodes = parents;
    index = Math.floor(index / 2);
  }
  return { root: nodes.get(0) ?? zero[20], pathElements };
}

if (existsSync(resolve(output, "deposit.json"))) {
  throw new Error(`refusing to overwrite existing live fixture directory: ${output}`);
}
const previous = append
  ? JSON.parse(readFileSync(resolve(root, "build/live-fixtures/public.json")))
  : null;
mkdirSync(output, { recursive: true });
const eddsa = await buildEddsa();
const F = eddsa.babyJub.F;
const poseidon = (values) => F.toObject(eddsa.poseidon(values));
const domainBytes = Buffer.from(config.deploymentDomain, "hex");
const poolBytes = Buffer.from(config.poolId.slice(2), "hex");
const coinBytes = Buffer.from(config.coinTypeHash, "hex");
if (coinBytes.length !== 32) throw new Error("config.coinTypeHash must be exactly 32 bytes");
const initialRoot = BigInt(`0x${config.initialRoot}`);
const [domainHi, domainLo] = limbs(domainBytes);
const [poolHi, poolLo] = limbs(poolBytes);
const [coinHi, coinLo] = limbs(coinBytes);
const deployment = poseidon([2100n, domainHi, domainLo, poolHi, poolLo, coinHi, coinLo, BigInt(config.verifierVersion)]);
const common = (kind) => Buffer.concat([Buffer.from("SCUT"), Buffer.from([1, kind]), domainBytes, poolBytes, coinBytes, u32(config.verifierVersion)]);
const buyerSeed = randomBytes(32);
const sellerSeed = randomBytes(32);
const buyer = eddsa.prv2pub(buyerSeed).map((value) => F.toObject(value));
const seller = eddsa.prv2pub(sellerSeed).map((value) => F.toObject(value));
const depositAmount = 10_000_000n;
const paymentAmount = 6_000_000n;
const changeAmount = depositAmount - paymentAmount;
const inputSpendSecret = scalar();
const inputSalt = scalar();
const inputSpendTag = poseidon([2006n, inputSpendSecret]);
const inputNote = poseidon([2010n, deployment, depositAmount, buyer[0], buyer[1], inputSpendTag, inputSalt]);
const oldLeaves = previous ? [BigInt(previous.inputNote)] : [];
const oldIndex = BigInt(oldLeaves.length);
const empty = tree(poseidon, oldLeaves, Number(oldIndex));
const expectedOldRoot = previous ? BigInt(previous.depositedRoot) : initialRoot;
if (empty.root !== expectedOldRoot) throw new Error("fixture root does not match the expected pool tree state");
const deposited = tree(poseidon, [...oldLeaves, inputNote], Number(oldIndex));
const depositStatement = Buffer.concat([common(1), u64(depositAmount), fieldBytes(inputNote), fieldBytes(empty.root), u64(oldIndex), fieldBytes(deposited.root), u64(oldIndex + 1n)]);
const deposit = {
  statement: [...depositStatement], ...digestInputs(depositStatement), ownerAx: buyer[0], ownerAy: buyer[1],
  spendSecret: inputSpendSecret, salt: inputSalt, appendSiblings: empty.pathElements,
};

const dealId = scalar(128);
const revision = 1n;
const transcriptRootLo = scalar(128);
const transcriptRootHi = scalar(128);
const serviceDigestLo = scalar(128);
const serviceDigestHi = scalar(128);
const settlementNonceLo = scalar(128);
const settlementNonceHi = scalar(128);
const blinding = scalar();
const expiry = BigInt(Date.now() + 60 * 60 * 1000);
const sellerSpendSecret = scalar();
const recipientSpendTag = poseidon([2006n, sellerSpendSecret]);
const paymentSalt = poseidon([2009n, deployment, settlementNonceLo, settlementNonceHi]);
const termsA = poseidon([2001n, deployment, dealId, revision, transcriptRootLo, transcriptRootHi]);
const termsB = poseidon([serviceDigestLo, serviceDigestHi, settlementNonceLo, settlementNonceHi, paymentAmount, expiry]);
const termsC = poseidon([buyer[0], buyer[1], seller[0], seller[1], recipientSpendTag, paymentSalt]);
const dealCommitment = poseidon([2002n, termsA, termsB, termsC, blinding, expiry]);
const dealNullifier = poseidon([2003n, deployment, buyer[0], buyer[1], settlementNonceLo, settlementNonceHi]);
const sign = (seed, message) => {
  const signature = eddsa.signPoseidon(seed, F.e(message));
  return { R8x: F.toObject(signature.R8[0]), R8y: F.toObject(signature.R8[1]), S: signature.S };
};
const buyerSig = sign(buyerSeed, poseidon([2004n, deployment, dealCommitment]));
const sellerSig = sign(sellerSeed, poseidon([2005n, deployment, dealCommitment]));
const inputNullifier = poseidon([2011n, deployment, inputSpendSecret, inputNote]);
const paymentNote = poseidon([2010n, deployment, paymentAmount, seller[0], seller[1], recipientSpendTag, paymentSalt]);
const changeSpendSecret = scalar();
const changeSalt = scalar();
const changeSpendTag = poseidon([2006n, changeSpendSecret]);
const changeNote = poseidon([2010n, deployment, changeAmount, buyer[0], buyer[1], changeSpendTag, changeSalt]);
const paymentAppend = tree(poseidon, [...oldLeaves, inputNote], Number(oldIndex + 1n));
const changeAppend = tree(poseidon, [...oldLeaves, inputNote, paymentNote], Number(oldIndex + 2n));
const finalTree = tree(poseidon, [...oldLeaves, inputNote, paymentNote, changeNote], Number(oldIndex + 1n));
const transferStatement = Buffer.concat([
  common(2), fieldBytes(dealCommitment), fieldBytes(dealNullifier), fieldBytes(inputNullifier), fieldBytes(paymentNote), fieldBytes(changeNote),
  u64(expiry), fieldBytes(deposited.root), u64(oldIndex + 1n), fieldBytes(finalTree.root), u64(oldIndex + 3n),
]);
const transfer = {
  statement: [...transferStatement], ...digestInputs(transferStatement), dealId, revision, transcriptRootLo, transcriptRootHi,
  serviceDigestLo, serviceDigestHi, settlementNonceLo, settlementNonceHi, paymentAmount, blinding,
  buyerAx: buyer[0], buyerAy: buyer[1], sellerAx: seller[0], sellerAy: seller[1], recipientSpendTag,
  buyerR8x: buyerSig.R8x, buyerR8y: buyerSig.R8y, buyerS: buyerSig.S, sellerR8x: sellerSig.R8x, sellerR8y: sellerSig.R8y, sellerS: sellerSig.S,
  inputAmount: depositAmount, inputSalt, inputSpendSecret, inputLeafIndex: oldIndex, inputPath: deposited.pathElements,
  changeAmount, changeSpendSecret, changeSalt, paymentAppendPath: paymentAppend.pathElements, changeAppendPath: changeAppend.pathElements,
};
const withdrawalNullifier = poseidon([2011n, deployment, sellerSpendSecret, paymentNote]);
const recipient = Buffer.from(config.sender.slice(2), "hex");
const withdrawStatement = Buffer.concat([common(3), fieldBytes(finalTree.root), fieldBytes(withdrawalNullifier), recipient, u64(paymentAmount)]);
const withdraw = {
  statement: [...withdrawStatement], ...digestInputs(withdrawStatement), ownerAx: seller[0], ownerAy: seller[1],
  spendSecret: sellerSpendSecret, salt: paymentSalt, leafIndex: oldIndex + 1n, pathElements: finalTree.pathElements,
};
for (const [name, fixture] of Object.entries({ deposit, transfer, withdraw })) {
  writeFileSync(resolve(output, `${name}.json`), `${JSON.stringify(asJson(fixture), null, 2)}\n`);
}
writeFileSync(resolve(output, "public.json"), `${JSON.stringify(asJson({
  depositAmount, paymentAmount, changeAmount, oldRoot: empty.root, oldIndex, depositedRoot: deposited.root, finalRoot: finalTree.root,
  depositNewIndex: oldIndex + 1n, transferNewIndex: oldIndex + 3n,
  inputNote, paymentNote, changeNote, dealCommitment, dealNullifier, inputNullifier, withdrawalNullifier,
  expiry, recipient: `0x${recipient.toString("hex")}`,
}), null, 2)}\n`);
writeFileSync(resolve(output, "recovery.json"), `${JSON.stringify(asJson({
  buyerSeed: buyerSeed.toString("hex"), sellerSeed: sellerSeed.toString("hex"), sellerSpendSecret, paymentSalt, paymentNote,
}), null, 2)}\n`, { mode: 0o600 });
console.log(`wrote ${append ? "append-bound " : ""}pool-bound fixtures to ${output}`);
