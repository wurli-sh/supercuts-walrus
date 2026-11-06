import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { MemWalManual } from "@mysten-incubation/memwal/manual";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { MemWal } from "@mysten-incubation/memwal";
import { MemoryFact, validateMemoryFact } from "./memory.js";
import { canonicalJson, SETTLEMENT_MEMORY_VERSION, validateSettlementMemory, type SettlementMemoryV1 } from "./settlement.js";

export const SIGNED_MEMORY_FORMAT = "supercuts.signed-memory.v1" as const;
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex"), SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const memoryMessage = (memory: unknown) => Buffer.from(`supercuts-memory-v1\n${canonicalJson(memory)}`);
function memorySeed(secret: string): Buffer {
  const decoded = decodeSuiPrivateKey(secret);
  if (decoded.scheme !== "ED25519") throw new TypeError("memory signing requires an ED25519 key");
  return Buffer.from(decoded.secretKey);
}
function memoryPublicKey(secret: string): Buffer {
  return Buffer.from(createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, memorySeed(secret)]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" })).subarray(SPKI_ED25519.length);
}
/** Sui address that signs this owner's trusted memories; derived from the owner-only memory key. */
export function memorySignerAddress(secret: string): string { return new Ed25519PublicKey(memoryPublicKey(secret)).toSuiAddress(); }
/** Plain-language line placed before the JSON so embeddings rank the record near scope queries. Not signed. */
export function describeMemory(memory: SettlementMemoryV1): string {
  const scope = [memory.scope.capabilityId, memory.scope.capabilityClass, memory.scope.counterparty ? `seller ${memory.scope.counterparty}` : undefined].filter(Boolean).join(" ");
  const signal = memory.signal;
  const fact = memory.kind === "outcome" ? `deal ${signal.outcome ?? "recorded"}${signal.rail ? ` via ${signal.rail}` : ""}${signal.amount ? ` for ${signal.amount} MIST` : ""}${signal.latencyMs !== undefined ? ` in ${Math.round(signal.latencyMs / 1000)}s` : ""}`
    : memory.kind === "privacy_rule" ? (signal.requiresShielded ? "owner requires shielded settlement" : "owner allows public settlement")
    : memory.kind === "budget_limit" ? `owner budget limit ${signal.maximumAmount} MIST${signal.periodMs ? ` per ${Math.round(signal.periodMs / 3_600_000)}h` : " per deal"}`
    : `${memory.kind} ${signal.reliability ?? signal.quality ?? ""}`.trim();
  return `Supercuts ${memory.provenance.replace("_", " ")}: ${fact}${scope ? ` for ${scope}` : ""}.`;
}

/** Wraps a trusted memory in a signed envelope so its authority survives a move to another machine. */
export function sealMemoryText(memory: SettlementMemoryV1, secret: string): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, memorySeed(secret)]), format: "der", type: "pkcs8" });
  return JSON.stringify({ format: SIGNED_MEMORY_FORMAT, summary: describeMemory(memory), memory, publicKey: memoryPublicKey(secret).toString("base64"), signature: edSign(null, memoryMessage(memory), key).toString("base64") });
}
/** Opens recalled memory text. `signedBy` is set only when the envelope signature verifies. */
export function openMemoryText(text: string): { memory: unknown; signedBy?: string } {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (!value || typeof value !== "object" || value.format !== SIGNED_MEMORY_FORMAT) return { memory: value };
  try {
    const raw = Buffer.from(String(value.publicKey), "base64");
    if (raw.length !== 32) return { memory: value.memory };
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
    return edVerify(null, memoryMessage(value.memory), key, Buffer.from(String(value.signature), "base64")) ? { memory: value.memory, signedBy: new Ed25519PublicKey(raw).toSuiAddress() } : { memory: value.memory };
  } catch { return { memory: value.memory }; }
}
import { RoleStore } from "./store.js";

export interface ManualMemoryConfig {
  key: string;
  accountId: string;
  serverUrl: string;
  suiPrivateKey: string;
  embeddingApiKey: string;
  embeddingApiBase: string;
  embeddingModel: string;
  packageId: string;
  registryId: string;
  namespace: string;
  walrusAggregatorUrl: string;
  walrusPublisherUrl: string;
}

/** Public Walrus Mainnet Memory and local-adapter values; owners only need to supply their own account secrets. */
export const MEMORY_MAINNET_DEFAULTS = {
  serverUrl: "https://relayer.memory.walrus.xyz",
  packageId: "0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5",
  registryId: "0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f",
  embeddingApiKey: "local-adapter",
  embeddingApiBase: "http://127.0.0.1:8787/v1",
  embeddingModel: "embeddinggemma-1536",
  walrusAggregatorUrl: "https://aggregator.walrus-mainnet.walrus.space",
  walrusPublisherUrl: "https://publisher.walrus-testnet.walrus.space",
} as const;

/** Completes an owner memory config: `key`, `accountId`, and `suiPrivateKey` are required; the rest default. */
export function withMemoryDefaults(raw: Partial<ManualMemoryConfig>, role: string): ManualMemoryConfig {
  for (const field of ["key", "accountId", "suiPrivateKey"] as const) if (typeof raw[field] !== "string" || !raw[field]) throw new TypeError(`memory config requires ${field}`);
  return { ...MEMORY_MAINNET_DEFAULTS, namespace: `supercuts:${role}`, ...Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined && value !== "")) } as ManualMemoryConfig;
}

/** Client-managed memory facade; plaintext never crosses the relayer boundary. */
export class ManualMemory {
  private readonly client: MemWalManual;
  private readonly signingKey: string | undefined;
  /** Address whose signature marks a recalled memory as this owner's own trusted record. */
  readonly signerAddress: string | undefined;
  constructor(private readonly store: RoleStore, config: ManualMemoryConfig) {
    try { this.signingKey = config.suiPrivateKey; this.signerAddress = memorySignerAddress(config.suiPrivateKey); } catch { this.signingKey = undefined; this.signerAddress = undefined; process.stderr.write("MEMORY_SIGNING_UNAVAILABLE: trusted memories will rely on local authority only\n"); }
    let embedding: URL; try { embedding = new URL(config.embeddingApiBase); } catch (error) { throw new TypeError(`embeddingApiBase is invalid: ${error instanceof Error ? error.message : "invalid URL"}`); }
    if (!["localhost", "127.0.0.1", "::1"].includes(embedding.hostname)) throw new TypeError("memory embeddings must use a loopback trusted endpoint");
    this.client = MemWalManual.create({ ...config, suiNetwork: "mainnet", preflightTimeoutMs: 15_000 });
  }
  async remember(fact: MemoryFact | SettlementMemoryV1): Promise<string> {
    if ((fact as { version?: string }).version === SETTLEMENT_MEMORY_VERSION) validateSettlementMemory(fact); else validateMemoryFact(fact as MemoryFact);
    const trusted = (fact as SettlementMemoryV1).version === SETTLEMENT_MEMORY_VERSION && ["owner_policy", "verified_outcome"].includes((fact as SettlementMemoryV1).provenance);
    const text = trusted && this.signingKey ? sealMemoryText(fact as SettlementMemoryV1, this.signingKey) : JSON.stringify(fact);
    const result = await this.client.rememberManual(text);
    this.store.putSecret(`memory:${result.blob_id}`, Buffer.from(text));
    return result.blob_id;
  }
  async recall(query: string, limit = 5): Promise<Array<{ blobId: string; text: string; distance: number }>> {
    const result = await this.client.recallManual(query, { limit });
    return result.results.map((item) => ({ blobId: item.blob_id, text: item.text, distance: item.distance }));
  }
  async listMetadata(config: ManualMemoryConfig): Promise<{ indexed: number; deleted: number; cursor: string | null }> {
    const client = MemWal.create({ key: config.key, accountId: config.accountId, serverUrl: config.serverUrl, namespace: config.namespace });
    let cursor = (this.store.db.prepare("SELECT cursor FROM memory_inventory_cursor WHERE namespace=?").get(config.namespace) as { cursor: string | null } | undefined)?.cursor ?? undefined;
    let indexed = 0, deleted = 0, restarted = false;
    try {
      for (;;) {
        const page = await client.listMemories({ ...(cursor ? { cursor } : {}), namespace: config.namespace });
        if (page.must_resync) {
          if (restarted) throw new Error("Walrus Memory inventory repeatedly requested a full resync");
          restarted = true; cursor = undefined;
          this.store.db.prepare("DELETE FROM memory_inventory WHERE namespace=?").run(config.namespace);
          this.store.db.prepare("DELETE FROM memory_inventory_cursor WHERE namespace=?").run(config.namespace);
          continue;
        }
        this.store.db.exec("BEGIN IMMEDIATE");
        try {
          for (const item of page.memories) {
            this.store.db.prepare("INSERT INTO memory_inventory(blob_id,memory_id,namespace,status,expires_at,deleted,updated_at) VALUES(?,?,?,?,?,0,?) ON CONFLICT(blob_id) DO UPDATE SET memory_id=excluded.memory_id,namespace=excluded.namespace,status=excluded.status,expires_at=excluded.expires_at,deleted=0,updated_at=excluded.updated_at")
              .run(item.blob_id, item.memory_id, item.namespace_id, item.status, item.expires_at, item.updated_at);
            indexed++;
          }
          for (const item of page.deleted) {
            this.store.db.prepare("UPDATE memory_inventory SET deleted=1,updated_at=? WHERE memory_id=? AND namespace=?").run(item.deleted_at, item.memory_id, item.namespace_id);
            deleted++;
          }
          this.store.db.prepare("INSERT INTO memory_inventory_cursor(namespace,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(namespace) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at")
            .run(config.namespace, page.next_cursor, Date.now());
          this.store.db.exec("COMMIT");
        } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
        cursor = page.next_cursor ?? undefined;
        if (!page.has_more) return { indexed, deleted, cursor: page.next_cursor };
        if (!cursor) throw new Error("Walrus Memory inventory has more pages without a cursor");
      }
    } finally { client.destroy(); }
  }
  destroy(): void { this.client.destroy(); }
}
