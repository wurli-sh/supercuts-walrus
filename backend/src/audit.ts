import { createHash } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import { SealClient, SessionKey } from "@mysten/seal";
import { fail } from "./errors.js";

export interface DisclosurePackage {
  version: 1;
  dealId: string;
  auditor: string;
  agreement: Record<string, unknown>;
  agreementOpening: string;
  transcriptRoot: string;
  authorizations: Array<{ author: string; signature: string }>;
  paymentDigest: string;
  dealNullifier: string;
}
export interface AuditChainEvidence { finalized: boolean; paymentDigest: string; dealNullifier: string; agreementCommitment: string; transcriptRoot: string; }
export type AuditEvidenceReader = (digest: string) => Promise<AuditChainEvidence | undefined>;
export type AuditAuthorizationVerifier = (author: string, bytes: Uint8Array, signature: string) => Promise<boolean>;
export type AgreementCommitmentDeriver = (agreement: Record<string, unknown>, opening: string) => Promise<string>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("AUDIT_PACKAGE_INVALID", "disclosure contains a non-JSON value");
  return encoded;
}

export function agreementCommitment(agreement: Record<string, unknown>, opening: string): string {
  const terms = Buffer.from(canonical(agreement)); const secret = Buffer.from(opening);
  const lengths = Buffer.alloc(8); lengths.writeUInt32BE(terms.length); lengths.writeUInt32BE(secret.length, 4);
  return createHash("sha256").update("supercuts-disclosure-agreement-v1\0").update(lengths).update(terms).update(secret).digest("hex");
}

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const U64_MAX = (1n << 64n) - 1n;
let poseidonPromise: ReturnType<typeof buildPoseidon> | undefined;

function decimal(name: string, value: unknown, maximum = FIELD_MODULUS - 1n): bigint {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed >= 0n && parsed <= maximum) return parsed;
  }
  return fail("AUDIT_PACKAGE_INVALID", `${name} must be a canonical decimal string inside its protocol range`);
}

/** Recomputes the exact protocol-v1 deal commitment opened by an audit package. */
export async function protocolAgreementCommitment(agreement: Record<string, unknown>, opening: string): Promise<string> {
  let parsedOpening: unknown;
  try { parsedOpening = JSON.parse(opening); } catch (error) { return fail("AUDIT_PACKAGE_INVALID", "agreement opening is not valid JSON", error); }
  if (!parsedOpening || typeof parsedOpening !== "object" || Array.isArray(parsedOpening)) fail("AUDIT_PACKAGE_INVALID", "agreement opening has an invalid shape");
  const secret = parsedOpening as Record<string, unknown>;
  if (Object.keys(secret).length !== 1 || !("blinding" in secret)) fail("AUDIT_PACKAGE_INVALID", "agreement opening must contain only the deal blinding");
  const fields = {
    deployment: decimal("deployment", agreement.deployment),
    dealId: decimal("dealId", agreement.dealId),
    revision: decimal("revision", agreement.revision, U64_MAX),
    transcriptRootLo: decimal("transcriptRootLo", agreement.transcriptRootLo),
    transcriptRootHi: decimal("transcriptRootHi", agreement.transcriptRootHi),
    serviceDigestLo: decimal("serviceDigestLo", agreement.serviceDigestLo),
    serviceDigestHi: decimal("serviceDigestHi", agreement.serviceDigestHi),
    settlementNonceLo: decimal("settlementNonceLo", agreement.settlementNonceLo),
    settlementNonceHi: decimal("settlementNonceHi", agreement.settlementNonceHi),
    paymentAmount: decimal("paymentAmount", agreement.paymentAmount, U64_MAX),
    expiry: decimal("expiry", agreement.expiry, U64_MAX),
    buyerAx: decimal("buyerAx", agreement.buyerAx), buyerAy: decimal("buyerAy", agreement.buyerAy),
    sellerAx: decimal("sellerAx", agreement.sellerAx), sellerAy: decimal("sellerAy", agreement.sellerAy),
    recipientSpendTag: decimal("recipientSpendTag", agreement.recipientSpendTag),
    blinding: decimal("blinding", secret.blinding),
  };
  if (Object.keys(agreement).length !== 16) fail("AUDIT_PACKAGE_INVALID", "agreement contains unexpected fields");
  const poseidon = await (poseidonPromise ??= buildPoseidon());
  const hash = (values: bigint[]) => poseidon.F.toObject(poseidon(values));
  const paymentSalt = hash([2009n, fields.deployment, fields.settlementNonceLo, fields.settlementNonceHi]);
  const termsA = hash([2001n, fields.deployment, fields.dealId, fields.revision, fields.transcriptRootLo, fields.transcriptRootHi]);
  const termsB = hash([fields.serviceDigestLo, fields.serviceDigestHi, fields.settlementNonceLo, fields.settlementNonceHi, fields.paymentAmount, fields.expiry]);
  const termsC = hash([fields.buyerAx, fields.buyerAy, fields.sellerAx, fields.sellerAy, fields.recipientSpendTag, paymentSalt]);
  return hash([2002n, termsA, termsB, termsC, fields.blinding, fields.expiry]).toString(16).padStart(64, "0");
}

export function disclosureAuthorizationBytes(pkg: Omit<DisclosurePackage, "authorizations">): Uint8Array {
  return Buffer.from(canonical({ domain: "supercuts-audit-v1", version: pkg.version, dealId: pkg.dealId, auditor: pkg.auditor, agreement: pkg.agreement, agreementOpening: pkg.agreementOpening, transcriptRoot: pkg.transcriptRoot, paymentDigest: pkg.paymentDigest, dealNullifier: pkg.dealNullifier }));
}

export function validateDisclosureShape(pkg: DisclosurePackage): void {
  if (!pkg || typeof pkg !== "object" || pkg.version !== 1 || !pkg.agreement || typeof pkg.agreement !== "object" || Array.isArray(pkg.agreement)
    || typeof pkg.agreementOpening !== "string" || !Array.isArray(pkg.authorizations)) fail("AUDIT_PACKAGE_INVALID", "disclosure has an invalid shape or version");
  const serialized = JSON.stringify(pkg);
  if (/spend(?:ing)?[_ -]?(?:key|secret)|parent[_ -]?session[_ -]?key|note[_ -]?opening/i.test(serialized)) {
    fail("AUDIT_SECRET_LEAK", "disclosure contains a wallet or parent-session secret");
  }
  if (![pkg.dealId, pkg.auditor, pkg.transcriptRoot, pkg.paymentDigest, pkg.dealNullifier].every((value) => typeof value === "string" && value.length > 0)
    || !pkg.authorizations.length || pkg.authorizations.some((item) => !item || typeof item.author !== "string" || !item.author || typeof item.signature !== "string" || !item.signature)) fail("AUDIT_PACKAGE_INVALID", "disclosure is incomplete");
}

export async function verifyDisclosure(
  pkg: DisclosurePackage, auditor: string, expectedDealId: string, read: AuditEvidenceReader,
  verifyAuthorization: AuditAuthorizationVerifier, expectedAuthors: ReadonlySet<string>,
  deriveCommitment: AgreementCommitmentDeriver,
): Promise<void> {
  validateDisclosureShape(pkg);
  if (pkg.auditor !== auditor) fail("AUDITOR_IDENTITY_MISMATCH", "disclosure was encrypted for another auditor");
  if (pkg.dealId !== expectedDealId) fail("AUDIT_DEAL_MISMATCH", "disclosure describes another deal");
  const evidence = await read(pkg.paymentDigest);
  if (!evidence) return fail("AUDIT_PAYMENT_MISMATCH", "disclosed payment was not found");
  if (!evidence.finalized) fail("AUDIT_PAYMENT_MISMATCH", "disclosed payment is not finalized");
  if (evidence.paymentDigest !== pkg.paymentDigest || evidence.dealNullifier !== pkg.dealNullifier) fail("AUDIT_PAYMENT_MISMATCH", "disclosed payment does not match finalized chain evidence");
  if (evidence.transcriptRoot !== pkg.transcriptRoot) fail("AUDIT_TRANSCRIPT_MISMATCH", "transcript root does not match chain-bound evidence");
  if (evidence.agreementCommitment !== await deriveCommitment(pkg.agreement, pkg.agreementOpening)) fail("AUDIT_TERMS_MISMATCH", "agreement opening does not match chain evidence");
  const { authorizations: _authorizations, ...unsigned } = pkg;
  const bytes = disclosureAuthorizationBytes(unsigned);
  const authors = new Set<string>();
  for (const authorization of pkg.authorizations) {
    if (authors.has(authorization.author) || !(await verifyAuthorization(authorization.author, bytes, authorization.signature))) fail("AUDIT_AUTHORIZATION_INVALID", "disclosure authorization is invalid or duplicated");
    authors.add(authorization.author);
  }
  if (authors.size !== expectedAuthors.size || [...expectedAuthors].some((author) => !authors.has(author))) fail("AUDIT_AUTHORIZATION_INVALID", "disclosure does not contain the exact required authorizers");
}

/** Adapter boundary for @mysten/seal encryption in the live process. */
export interface SealDisclosureTransport {
  encrypt(auditor: string, plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(auditor: string, ciphertext: Uint8Array): Promise<Uint8Array>;
}

export interface SealAuthorization {
  sessionKey: SessionKey;
  txBytes: Uint8Array;
}

/** Live Seal adapter; the authorization transaction must approve only the designated auditor. */
export class SealClientDisclosureTransport implements SealDisclosureTransport {
  constructor(
    private readonly client: SealClient,
    private readonly packageId: string,
    private readonly threshold: number,
    private readonly authorize: (auditor: string, ciphertext: Uint8Array) => Promise<SealAuthorization>,
  ) {}
  async encrypt(auditor: string, plaintext: Uint8Array): Promise<Uint8Array> {
    if (!/^0x[0-9a-f]{64}$/i.test(auditor) || !/^0x[0-9a-f]{64}$/i.test(this.packageId) || !Number.isSafeInteger(this.threshold) || this.threshold < 1) fail("SEAL_CONFIG_INVALID", "Seal auditor, package, or threshold is invalid");
    const result = await this.client.encrypt({ threshold: this.threshold, packageId: this.packageId, id: auditor.replace(/^0x/, ""), data: plaintext });
    return result.encryptedObject;
  }
  async decrypt(auditor: string, ciphertext: Uint8Array): Promise<Uint8Array> {
    const authorization = await this.authorize(auditor, ciphertext);
    return this.client.decrypt({ data: ciphertext, sessionKey: authorization.sessionKey, txBytes: authorization.txBytes });
  }
}

export async function sealDisclosure(pkg: DisclosurePackage, seal: SealDisclosureTransport): Promise<Uint8Array> {
  validateDisclosureShape(pkg);
  return seal.encrypt(pkg.auditor, Buffer.from(JSON.stringify(pkg)));
}

export async function openDisclosure(ciphertext: Uint8Array, auditor: string, seal: SealDisclosureTransport): Promise<DisclosurePackage> {
  const plaintext = await seal.decrypt(auditor, ciphertext);
  let pkg: DisclosurePackage;
  try { pkg = JSON.parse(Buffer.from(plaintext).toString()) as DisclosurePackage; } catch (error) { return fail("AUDIT_PACKAGE_INVALID", "disclosure is not valid JSON", error); }
  validateDisclosureShape(pkg);
  if (pkg.auditor !== auditor) fail("AUDITOR_IDENTITY_MISMATCH", "disclosure was encrypted for another auditor");
  return pkg;
}
