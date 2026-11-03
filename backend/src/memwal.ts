import { MemWalManual } from "@mysten-incubation/memwal/manual";
import { MemWal } from "@mysten-incubation/memwal";
import { MemoryFact, validateMemoryFact } from "./memory.js";
import { SETTLEMENT_MEMORY_VERSION, validateSettlementMemory, type SettlementMemoryV1 } from "./settlement.js";
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

/** Client-managed memory facade; plaintext never crosses the relayer boundary. */
export class ManualMemory {
  private readonly client: MemWalManual;
  constructor(private readonly store: RoleStore, config: ManualMemoryConfig) {
    let embedding: URL; try { embedding = new URL(config.embeddingApiBase); } catch (error) { throw new TypeError(`embeddingApiBase is invalid: ${error instanceof Error ? error.message : "invalid URL"}`); }
    if (!["localhost", "127.0.0.1", "::1"].includes(embedding.hostname)) throw new TypeError("memory embeddings must use a loopback trusted endpoint");
    this.client = MemWalManual.create({ ...config, suiNetwork: "mainnet", preflightTimeoutMs: 15_000 });
  }
  async remember(fact: MemoryFact | SettlementMemoryV1): Promise<string> {
    if ((fact as { version?: string }).version === SETTLEMENT_MEMORY_VERSION) validateSettlementMemory(fact); else validateMemoryFact(fact as MemoryFact);
    const text = JSON.stringify(fact);
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
