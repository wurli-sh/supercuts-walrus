import { MemWalManual } from "@mysten-incubation/memwal/manual";
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
    this.client = MemWalManual.create({ ...config, suiNetwork: "mainnet" });
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
  destroy(): void { this.client.destroy(); }
}
