import { createHash } from "node:crypto";
import { buildEddsa } from "circomlibjs";

const bytes32 = (byte) => Buffer.alloc(32, byte);
const u32 = (value) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
const u64 = (value) => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; };
const fieldBytes = (value) => Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex");
const limbs = (buffer) => [BigInt(`0x${buffer.subarray(0, 16).toString("hex")}`), BigInt(`0x${buffer.subarray(16).toString("hex")}`)];
const digestInputs = (statement) => {
  const digest = createHash("sha256").update(statement).digest();
  return {
    digestHigh: BigInt(`0x${digest.subarray(0, 16).toString("hex")}`).toString(),
    digestLow: BigInt(`0x${digest.subarray(16).toString("hex")}`).toString(),
  };
};
const strings = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));

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
      if (parents.has(parent)) continue;
      parents.set(parent, poseidon([nodes.get(parent * 2) ?? zero[level], nodes.get(parent * 2 + 1) ?? zero[level]]));
    }
    nodes = parents;
    index = Math.floor(index / 2);
  }
  return { root: nodes.get(0) ?? zero[20], pathElements };
}

export async function semanticFixtures(version = 1, options = {}) {
  if (version !== 1 && version !== 2) throw new Error("unsupported semantic fixture version");
  const eddsa = await buildEddsa();
  const F = eddsa.babyJub.F;
  const poseidon = (values) => F.toObject(eddsa.poseidon(values));
  const domainBytes = bytes32(0x11);
  const poolBytes = bytes32(0x22);
  const coinBytes = bytes32(0x33);
  const common = (kind) => Buffer.concat([Buffer.from("SCUT"), Buffer.from([version, kind]), domainBytes, poolBytes, coinBytes, u32(version)]);
  const [domainHi, domainLo] = limbs(domainBytes);
  const [poolHi, poolLo] = limbs(poolBytes);
  const [coinHi, coinLo] = limbs(coinBytes);
  const deployment = poseidon([2100n, domainHi, domainLo, poolHi, poolLo, coinHi, coinLo, BigInt(version)]);

  const buyerSeed = createHash("sha256").update("SUPERCUTS_BUYER_TEST_ONLY").digest();
  const sellerSeed = createHash("sha256").update("SUPERCUTS_SELLER_TEST_ONLY").digest();
  const buyer = eddsa.prv2pub(buyerSeed).map((value) => F.toObject(value));
  const seller = eddsa.prv2pub(sellerSeed).map((value) => F.toObject(value));
  const inputSpendSecret = 101n;
  const inputSalt = 102n;
  const inputSpendTag = poseidon([2006n, inputSpendSecret]);
  const inputAmount = version === 2 ? 10000000n : 100n;
  const inputNote = poseidon([2010n, deployment, inputAmount, buyer[0], buyer[1], inputSpendTag, inputSalt]);
  const empty = tree(poseidon, [], 0);
  const deposited = tree(poseidon, [inputNote], 0);
  const depositStatement = Buffer.concat([
    common(1), u64(inputAmount), fieldBytes(inputNote), fieldBytes(empty.root), u64(0), fieldBytes(deposited.root), u64(1),
  ]);
  const deposit = {
    statement: [...depositStatement], ...digestInputs(depositStatement),
    ownerAx: buyer[0], ownerAy: buyer[1], spendSecret: inputSpendSecret, salt: inputSalt,
    appendSiblings: empty.pathElements,
  };

  const dealId = 500n;
  const revision = 1n;
  const transcriptRootLo = 501n;
  const transcriptRootHi = 502n;
  const serviceDigestLo = 503n;
  const serviceDigestHi = 504n;
  const settlementNonceLo = 505n;
  const settlementNonceHi = 506n;
  const paymentAmount = version === 2 ? 3000000n : 60n;
  const changeAmount = inputAmount - paymentAmount;
  const blinding = 507n;
  const expiry = 1900000000000n;
  const sellerSpendSecret = 601n;
  const recipientSpendTag = poseidon([2006n, sellerSpendSecret]);
  const paymentSalt = poseidon([2009n, deployment, settlementNonceLo, settlementNonceHi]);
  const termsA = poseidon([2001n, deployment, dealId, revision, transcriptRootLo, transcriptRootHi]);
  const termsB = poseidon([serviceDigestLo, serviceDigestHi, settlementNonceLo, settlementNonceHi, paymentAmount, expiry]);
  const termsC = poseidon([buyer[0], buyer[1], seller[0], seller[1], recipientSpendTag, paymentSalt]);
  const dealCommitment = poseidon([2002n, termsA, termsB, termsC, blinding, expiry]);
  const dealNullifier = poseidon([2003n, deployment, buyer[0], buyer[1], settlementNonceLo, settlementNonceHi]);
  const buyerMessage = poseidon([2004n, deployment, dealCommitment]);
  const sellerMessage = poseidon([2005n, deployment, dealCommitment]);
  const buyerSignature = eddsa.signPoseidon(buyerSeed, F.e(buyerMessage));
  const sellerSignature = eddsa.signPoseidon(sellerSeed, F.e(sellerMessage));
  const signature = (sig) => ({ R8x: F.toObject(sig.R8[0]), R8y: F.toObject(sig.R8[1]), S: sig.S });
  const buyerSig = signature(buyerSignature);
  const sellerSig = signature(sellerSignature);
  const inputNullifier = poseidon([2011n, deployment, inputSpendSecret, inputNote]);
  const paymentNote = poseidon([2010n, deployment, paymentAmount, seller[0], seller[1], recipientSpendTag, paymentSalt]);
  const changeSpendSecret = 701n;
  const changeSalt = 702n;
  const changeSpendTag = poseidon([2006n, changeSpendSecret]);
  const changeNote = poseidon([2010n, deployment, changeAmount, buyer[0], buyer[1], changeSpendTag, changeSalt]);
  const paymentAppend = tree(poseidon, [inputNote], 1);
  const middle = tree(poseidon, [inputNote, paymentNote], 1);
  const changeAppend = tree(poseidon, [inputNote, paymentNote], 2);
  const finalTree = tree(poseidon, [inputNote, paymentNote, changeNote], 1);
  const transferStatement = Buffer.concat([
    common(2), fieldBytes(dealCommitment), fieldBytes(dealNullifier), fieldBytes(inputNullifier),
    fieldBytes(paymentNote), fieldBytes(changeNote), u64(expiry), fieldBytes(deposited.root), u64(1),
    fieldBytes(finalTree.root), u64(3),
  ]);
  const transfer = {
    statement: [...transferStatement], ...digestInputs(transferStatement), dealId, revision,
    transcriptRootLo, transcriptRootHi, serviceDigestLo, serviceDigestHi, settlementNonceLo,
    settlementNonceHi, paymentAmount, blinding, buyerAx: buyer[0], buyerAy: buyer[1],
    sellerAx: seller[0], sellerAy: seller[1], recipientSpendTag,
    buyerR8x: buyerSig.R8x, buyerR8y: buyerSig.R8y, buyerS: buyerSig.S,
    sellerR8x: sellerSig.R8x, sellerR8y: sellerSig.R8y, sellerS: sellerSig.S,
    inputAmount, inputSalt, inputSpendSecret, inputLeafIndex: 0n,
    inputPath: deposited.pathElements, changeAmount, changeSpendSecret, changeSalt,
    paymentAppendPath: paymentAppend.pathElements, changeAppendPath: changeAppend.pathElements,
  };
  if (middle.root !== tree(poseidon, [inputNote, paymentNote], 0).root) throw new Error("middle root mismatch");

  const withdrawalNullifier = poseidon([2011n, deployment, sellerSpendSecret, paymentNote]);
  const recipient = bytes32(0x77);
  const exitAmount = version === 2 ? BigInt(options.exitAmount ?? 1000000n) : paymentAmount;
  const exitChangeAmount = paymentAmount - exitAmount;
  const exitChangeSpendSecret = 801n;
  const exitChangeSalt = 802n;
  const exitChangeTag = poseidon([2006n, exitChangeSpendSecret]);
  const exitChangeNote = poseidon([2010n, deployment, exitChangeAmount, seller[0], seller[1], exitChangeTag, exitChangeSalt]);
  const exitTree = tree(poseidon, [inputNote, paymentNote, changeNote, exitChangeNote], 3);
  const withdrawStatement = version === 2
    ? Buffer.concat([common(3), fieldBytes(finalTree.root), fieldBytes(withdrawalNullifier), recipient, u64(exitAmount), Buffer.from([options.exactExit ? 1 : 0]), fieldBytes(exitChangeNote), u64(3), fieldBytes(exitTree.root), u64(4)])
    : Buffer.concat([common(3), fieldBytes(finalTree.root), fieldBytes(withdrawalNullifier), recipient, u64(paymentAmount)]);
  const withdraw = {
    statement: [...withdrawStatement], ...digestInputs(withdrawStatement), ownerAx: seller[0], ownerAy: seller[1],
    ...(version === 2 ? { inputAmount: paymentAmount, changeAmount: exitChangeAmount, changeSpendSecret: exitChangeSpendSecret, changeSalt: exitChangeSalt, appendSiblings: tree(poseidon, [inputNote, paymentNote, changeNote], 3).pathElements } : {}),
    spendSecret: sellerSpendSecret, salt: paymentSalt, leafIndex: 1n, pathElements: finalTree.pathElements,
  };
  return strings({ deposit, transfer, withdraw, public: {
    emptyRoot: empty.root, inputNote, depositedRoot: deposited.root, paymentNote, changeNote,
    finalRoot: finalTree.root, dealCommitment, dealNullifier, inputNullifier, withdrawalNullifier,
  } });
}

