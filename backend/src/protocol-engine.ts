import { createHash, randomBytes } from "node:crypto";
import { buildEddsa } from "circomlibjs";
import { fail } from "./errors.js";

export const TREE_DEPTH = 20;
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const asStrings = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)) as T;
const fieldBytes = (value: bigint) => Buffer.from(value.toString(16).padStart(64, "0"), "hex");
const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
const u64 = (value: bigint) => { const out = Buffer.alloc(8); out.writeBigUInt64BE(value); return out; };
const limbs = (value: Buffer): [bigint, bigint] => [BigInt(`0x${value.subarray(0, 16).toString("hex")}`), BigInt(`0x${value.subarray(16).toString("hex")}`)];
const digestInputs = (statement: Buffer) => { const digest = createHash("sha256").update(statement).digest(); return { digestHigh: BigInt(`0x${digest.subarray(0, 16).toString("hex")}`), digestLow: BigInt(`0x${digest.subarray(16).toString("hex")}`) }; };
const scalar = (bytes = 31): bigint => { for (;;) { const value = BigInt(`0x${randomBytes(bytes).toString("hex")}`); if (value > 0n && value < FIELD_MODULUS) return value; } };

export interface ProtocolDeployment {
  deploymentDomain: string; poolId: string; coinTypeHash: string; verifierVersion: number; initialRoot: string;
}
export interface ProtocolIdentity { seed: Uint8Array; publicKey: [bigint, bigint]; }
export interface NoteOpeningData { deployment: bigint; amount: bigint; ownerAx: bigint; ownerAy: bigint; spendSecret: bigint; salt: bigint; commitment: bigint; leafIndex: bigint; }
export interface AcceptedAgreement {
  dealId: bigint; revision: bigint; transcriptRootLo: bigint; transcriptRootHi: bigint;
  serviceDigestLo: bigint; serviceDigestHi: bigint; settlementNonceLo: bigint; settlementNonceHi: bigint;
  paymentAmount: bigint; blinding: bigint; expiry: bigint; buyer: ProtocolIdentity; sellerPublicKey: [bigint, bigint];
  sellerSignature: { R8x: bigint; R8y: bigint; S: bigint }; recipientSpendTag: bigint;
}
export interface DepositWitness { input: Record<string, unknown>; opening: NoteOpeningData; newRoot: bigint; newIndex: bigint; statement: Buffer; }
export interface TransferWitness {
  input: Record<string, unknown>; statement: Buffer; newRoot: bigint; newIndex: bigint;
  dealCommitment: bigint; dealNullifier: bigint; inputNullifier: bigint; paymentCommitment: bigint; changeCommitment: bigint;
  paymentSalt: bigint; changeOpening: NoteOpeningData;
}
export interface WithdrawWitness { input: Record<string, unknown>; statement: Buffer; noteNullifier: bigint; }
export interface WithdrawV2Witness extends WithdrawWitness { newRoot: bigint; newIndex: bigint; changeOpening: NoteOpeningData; exactExit: boolean; amount: bigint; }
export interface AgreementValues { paymentSalt: bigint; dealCommitment: bigint; dealNullifier: bigint; }

export class PoseidonTree {
  readonly zeroes: bigint[];
  constructor(readonly leaves: bigint[], private readonly poseidon: (values: bigint[]) => bigint) {
    if (leaves.length >= 2 ** TREE_DEPTH) fail("TREE_EXHAUSTED", "protocol tree is full");
    this.zeroes = [0n]; for (let level = 0; level < TREE_DEPTH; level++) this.zeroes.push(poseidon([this.zeroes[level]!, this.zeroes[level]!]));
  }
  path(selectedIndex: number): { root: bigint; siblings: bigint[] } {
    if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= 2 ** TREE_DEPTH) fail("TREE_INDEX_INVALID", "tree index is outside the protocol range");
    let nodes = new Map(this.leaves.map((leaf, index) => [index, leaf])); let index = selectedIndex; const siblings: bigint[] = [];
    for (let level = 0; level < TREE_DEPTH; level++) {
      siblings.push(nodes.get(index ^ 1) ?? this.zeroes[level]!); const parents = new Map<number, bigint>();
      for (const position of nodes.keys()) { const parent = Math.floor(position / 2); if (!parents.has(parent)) parents.set(parent, this.poseidon([nodes.get(parent * 2) ?? this.zeroes[level]!, nodes.get(parent * 2 + 1) ?? this.zeroes[level]!])); }
      nodes = parents; index = Math.floor(index / 2);
    }
    return { root: nodes.get(0) ?? this.zeroes[TREE_DEPTH]!, siblings };
  }
  get root(): bigint { return this.path(0).root; }
  appendPath(): bigint[] { return this.path(this.leaves.length).siblings; }
}

export class ProtocolEngine {
  private constructor(
    readonly deployment: ProtocolDeployment, readonly deploymentField: bigint,
    private readonly eddsa: Awaited<ReturnType<typeof buildEddsa>>, private readonly poseidonHash: (values: bigint[]) => bigint,
  ) {}
  static async create(deployment: ProtocolDeployment): Promise<ProtocolEngine> {
    const domain = Buffer.from(deployment.deploymentDomain.replace(/^0x/, ""), "hex"), pool = Buffer.from(deployment.poolId.replace(/^0x/, ""), "hex"), coin = Buffer.from(deployment.coinTypeHash.replace(/^0x/, ""), "hex");
    if ([domain, pool, coin].some((value) => value.length !== 32) || !Number.isSafeInteger(deployment.verifierVersion) || deployment.verifierVersion < 1) fail("CONFIG_INVALID", "protocol deployment fields are invalid");
    const eddsa = await buildEddsa(); const F = eddsa.babyJub.F; const poseidon = (values: bigint[]) => F.toObject(eddsa.poseidon(values));
    const [domainHi, domainLo] = limbs(domain), [poolHi, poolLo] = limbs(pool), [coinHi, coinLo] = limbs(coin);
    return new ProtocolEngine(deployment, poseidon([2100n, domainHi, domainLo, poolHi, poolLo, coinHi, coinLo, BigInt(deployment.verifierVersion)]), eddsa, poseidon);
  }
  identity(seed: Uint8Array = randomBytes(32)): ProtocolIdentity { if (seed.length !== 32) fail("IDENTITY_INVALID", "BabyJub identity seed must contain 32 bytes"); const F = this.eddsa.babyJub.F; return { seed: Uint8Array.from(seed), publicKey: this.eddsa.prv2pub(seed).map((value) => F.toObject(value)) as [bigint, bigint] }; }
  randomScalar(): bigint { return scalar(); }
  spendTag(secret: bigint): bigint { return this.poseidonHash([2006n, secret]); }
  noteCommitment(amount: bigint, owner: [bigint, bigint], spendSecret: bigint, salt: bigint): bigint { return this.poseidonHash([2010n, this.deploymentField, amount, owner[0], owner[1], this.spendTag(spendSecret), salt]); }
  sign(identity: ProtocolIdentity, domain: 2004n | 2005n, agreement: bigint) { const F = this.eddsa.babyJub.F; const signature = this.eddsa.signPoseidon(identity.seed, F.e(this.poseidonHash([domain, this.deploymentField, agreement]))); return { R8x: F.toObject(signature.R8[0]), R8y: F.toObject(signature.R8[1]), S: signature.S }; }
  verify(publicKey: [bigint, bigint], domain: 2004n | 2005n, agreement: bigint, signature: { R8x: bigint; R8y: bigint; S: bigint }): boolean { const F = this.eddsa.babyJub.F; return this.eddsa.verifyPoseidon(F.e(this.poseidonHash([domain, this.deploymentField, agreement])), { R8: [F.e(signature.R8x), F.e(signature.R8y)], S: signature.S }, [F.e(publicKey[0]), F.e(publicKey[1])]); }
  private header(kind: 1 | 2 | 3): Buffer { return Buffer.concat([Buffer.from("SCUT"), Buffer.from([this.deployment.verifierVersion === 2 ? 2 : 1, kind]), Buffer.from(this.deployment.deploymentDomain.replace(/^0x/, ""), "hex"), Buffer.from(this.deployment.poolId.replace(/^0x/, ""), "hex"), Buffer.from(this.deployment.coinTypeHash.replace(/^0x/, ""), "hex"), u32(this.deployment.verifierVersion)]); }
  tree(leaves: bigint[]): PoseidonTree { return new PoseidonTree(leaves, this.poseidonHash); }
  buildDeposit(leaves: bigint[], owner: ProtocolIdentity, amount: bigint, spendSecret = scalar(), salt = scalar()): DepositWitness {
    if (amount <= 0n || amount >= 1n << 64n) fail("AMOUNT_INVALID", "deposit amount must be a positive u64");
    if (this.deployment.verifierVersion === 2 && amount !== 10_000_000n && amount !== 100_000_000n) fail("AMOUNT_INVALID", "v2 deposits must be 10,000,000 or 100,000,000 MIST");
    const tree = this.tree(leaves), oldRoot = tree.root, leafIndex = BigInt(leaves.length), commitment = this.noteCommitment(amount, owner.publicKey, spendSecret, salt), nextTree = this.tree([...leaves, commitment]), newRoot = nextTree.root, newIndex = leafIndex + 1n;
    const expectedInitial = BigInt(`0x${this.deployment.initialRoot.replace(/^0x/, "")}`); if (!leaves.length && oldRoot !== expectedInitial) fail("INITIAL_ROOT_MISMATCH", "circuit zero tree differs from the pinned initial root");
    const statement = Buffer.concat([this.header(1), u64(amount), fieldBytes(commitment), fieldBytes(oldRoot), u64(leafIndex), fieldBytes(newRoot), u64(newIndex)]);
    const input = asStrings({ statement: [...statement], ...digestInputs(statement), ownerAx: owner.publicKey[0], ownerAy: owner.publicKey[1], spendSecret, salt, appendSiblings: tree.appendPath() });
    return { input, opening: { deployment: this.deploymentField, amount, ownerAx: owner.publicKey[0], ownerAy: owner.publicKey[1], spendSecret, salt, commitment, leafIndex }, newRoot, newIndex, statement };
  }
  agreementValues(agreement: Omit<AcceptedAgreement, "sellerSignature">): AgreementValues {
    const buyer = agreement.buyer.publicKey, seller = agreement.sellerPublicKey, paymentSalt = this.poseidonHash([2009n, this.deploymentField, agreement.settlementNonceLo, agreement.settlementNonceHi]);
    const termsA = this.poseidonHash([2001n, this.deploymentField, agreement.dealId, agreement.revision, agreement.transcriptRootLo, agreement.transcriptRootHi]);
    const termsB = this.poseidonHash([agreement.serviceDigestLo, agreement.serviceDigestHi, agreement.settlementNonceLo, agreement.settlementNonceHi, agreement.paymentAmount, agreement.expiry]);
    const termsC = this.poseidonHash([buyer[0], buyer[1], seller[0], seller[1], agreement.recipientSpendTag, paymentSalt]);
    return { paymentSalt, dealCommitment: this.poseidonHash([2002n, termsA, termsB, termsC, agreement.blinding, agreement.expiry]), dealNullifier: this.poseidonHash([2003n, this.deploymentField, buyer[0], buyer[1], agreement.settlementNonceLo, agreement.settlementNonceHi]) };
  }
  buildTransfer(leaves: bigint[], inputNote: NoteOpeningData, agreement: AcceptedAgreement, changeSpendSecret = scalar(), changeSalt = scalar()): TransferWitness {
    if (agreement.paymentAmount <= 0n || agreement.paymentAmount >= inputNote.amount || agreement.expiry <= BigInt(Date.now())) fail("AGREEMENT_INVALID", "agreement amount must leave positive change and expiry must be in the future");
    const buyer = agreement.buyer.publicKey, seller = agreement.sellerPublicKey, { paymentSalt, dealCommitment, dealNullifier } = this.agreementValues(agreement);
    const buyerSignature = this.sign(agreement.buyer, 2004n, dealCommitment);
    const inputCommitment = this.noteCommitment(inputNote.amount, buyer, inputNote.spendSecret, inputNote.salt); if (inputCommitment !== inputNote.commitment || leaves[Number(inputNote.leafIndex)] !== inputCommitment) fail("INPUT_NOTE_MISMATCH", "input note opening does not match indexed leaf");
    const inputNullifier = this.poseidonHash([2011n, this.deploymentField, inputNote.spendSecret, inputCommitment]);
    const paymentCommitment = this.poseidonHash([2010n, this.deploymentField, agreement.paymentAmount, seller[0], seller[1], agreement.recipientSpendTag, paymentSalt]);
    const changeAmount = inputNote.amount - agreement.paymentAmount, changeCommitment = this.noteCommitment(changeAmount, buyer, changeSpendSecret, changeSalt);
    const oldTree = this.tree(leaves), oldRoot = oldTree.root, oldIndex = BigInt(leaves.length), afterPayment = this.tree([...leaves, paymentCommitment]), finalTree = this.tree([...leaves, paymentCommitment, changeCommitment]), newRoot = finalTree.root, newIndex = oldIndex + 2n;
    const statement = Buffer.concat([this.header(2), fieldBytes(dealCommitment), fieldBytes(dealNullifier), fieldBytes(inputNullifier), fieldBytes(paymentCommitment), fieldBytes(changeCommitment), u64(agreement.expiry), fieldBytes(oldRoot), u64(oldIndex), fieldBytes(newRoot), u64(newIndex)]);
    const input = asStrings({ statement: [...statement], ...digestInputs(statement), dealId: agreement.dealId, revision: agreement.revision, transcriptRootLo: agreement.transcriptRootLo, transcriptRootHi: agreement.transcriptRootHi, serviceDigestLo: agreement.serviceDigestLo, serviceDigestHi: agreement.serviceDigestHi, settlementNonceLo: agreement.settlementNonceLo, settlementNonceHi: agreement.settlementNonceHi, paymentAmount: agreement.paymentAmount, blinding: agreement.blinding, buyerAx: buyer[0], buyerAy: buyer[1], sellerAx: seller[0], sellerAy: seller[1], recipientSpendTag: agreement.recipientSpendTag, buyerR8x: buyerSignature.R8x, buyerR8y: buyerSignature.R8y, buyerS: buyerSignature.S, sellerR8x: agreement.sellerSignature.R8x, sellerR8y: agreement.sellerSignature.R8y, sellerS: agreement.sellerSignature.S, inputAmount: inputNote.amount, inputSalt: inputNote.salt, inputSpendSecret: inputNote.spendSecret, inputLeafIndex: inputNote.leafIndex, inputPath: oldTree.path(Number(inputNote.leafIndex)).siblings, changeAmount, changeSpendSecret, changeSalt, paymentAppendPath: oldTree.appendPath(), changeAppendPath: afterPayment.appendPath() });
    return { input, statement, newRoot, newIndex, dealCommitment, dealNullifier, inputNullifier, paymentCommitment, changeCommitment, paymentSalt, changeOpening: { deployment: this.deploymentField, amount: changeAmount, ownerAx: buyer[0], ownerAy: buyer[1], spendSecret: changeSpendSecret, salt: changeSalt, commitment: changeCommitment, leafIndex: oldIndex + 1n } };
  }
  buildWithdraw(leaves: bigint[], note: NoteOpeningData, recipient: string): WithdrawWitness {
    const address = Buffer.from(recipient.replace(/^0x/, ""), "hex"); if (address.length !== 32) fail("RECIPIENT_INVALID", "withdrawal recipient must be a 32-byte Sui address");
    const tree = this.tree(leaves), commitment = this.noteCommitment(note.amount, [note.ownerAx, note.ownerAy], note.spendSecret, note.salt); if (commitment !== note.commitment || leaves[Number(note.leafIndex)] !== commitment) fail("NOTE_RECOVERY_MISMATCH", "withdrawal opening does not match indexed leaf");
    const noteNullifier = this.poseidonHash([2011n, this.deploymentField, note.spendSecret, commitment]); const statement = Buffer.concat([this.header(3), fieldBytes(tree.root), fieldBytes(noteNullifier), address, u64(note.amount)]);
    const input = asStrings({ statement: [...statement], ...digestInputs(statement), ownerAx: note.ownerAx, ownerAy: note.ownerAy, spendSecret: note.spendSecret, salt: note.salt, leafIndex: note.leafIndex, pathElements: tree.path(Number(note.leafIndex)).siblings });
    return { input, statement, noteNullifier };
  }
  buildWithdrawV2(leaves: bigint[], note: NoteOpeningData, recipient: string, amount: bigint, exactExit = false, changeSpendSecret = scalar(), changeSalt = scalar()): WithdrawV2Witness {
    if (this.deployment.verifierVersion !== 2) fail("POOL_VERSION_INVALID", "v2 withdrawals require a v2 deployment");
    if (amount <= 0n || amount > note.amount || (!exactExit && amount !== 1_000_000n)) fail("AMOUNT_INVALID", "standard exit is 1,000,000 MIST; an exact exit may reveal another amount");
    if (!/^0x[0-9a-f]{64}$/i.test(recipient)) fail("RECIPIENT_INVALID", "withdrawal recipient must be a 32-byte Sui address");
    const tree = this.tree(leaves), commitment = this.noteCommitment(note.amount, [note.ownerAx, note.ownerAy], note.spendSecret, note.salt);
    if (commitment !== note.commitment || leaves[Number(note.leafIndex)] !== commitment) fail("NOTE_RECOVERY_MISMATCH", "withdrawal opening does not match indexed leaf");
    const changeAmount = note.amount - amount, leafIndex = BigInt(leaves.length);
    const changeCommitment = this.noteCommitment(changeAmount, [note.ownerAx, note.ownerAy], changeSpendSecret, changeSalt);
    const nextTree = this.tree([...leaves, changeCommitment]), newRoot = nextTree.root, newIndex = leafIndex + 1n;
    const noteNullifier = this.poseidonHash([2011n, this.deploymentField, note.spendSecret, commitment]);
    const address = Buffer.from(recipient.slice(2), "hex");
    const statement = Buffer.concat([this.header(3), fieldBytes(tree.root), fieldBytes(noteNullifier), address, u64(amount), Buffer.from([Number(exactExit)]), fieldBytes(changeCommitment), u64(leafIndex), fieldBytes(newRoot), u64(newIndex)]);
    const input = asStrings({ statement: [...statement], ...digestInputs(statement), ownerAx: note.ownerAx, ownerAy: note.ownerAy, inputAmount: note.amount, spendSecret: note.spendSecret, salt: note.salt, leafIndex: note.leafIndex, pathElements: tree.path(Number(note.leafIndex)).siblings, changeAmount, changeSpendSecret, changeSalt, appendSiblings: tree.appendPath() });
    return { input, statement, noteNullifier, newRoot, newIndex, changeOpening: { deployment: this.deploymentField, amount: changeAmount, ownerAx: note.ownerAx, ownerAy: note.ownerAy, spendSecret: changeSpendSecret, salt: changeSalt, commitment: changeCommitment, leafIndex }, exactExit, amount };
  }
}
