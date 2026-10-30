import { MemWalManual } from "@mysten-incubation/memwal/manual";
import { MemoryFact, validateMemoryFact } from "./memory.js";
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
    this.client = MemWalManual.create({ ...config, suiNetwork: "mainnet" });
  }
  async remember(fact: MemoryFact): Promise<string> {
    validateMemoryFact(fact);
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
