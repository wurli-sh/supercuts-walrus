import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { ManualMemory } from "../src/memwal.js";
import { RoleStore } from "../src/store.js";

async function closedPort(): Promise<number> {
  const server = createServer(); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address === "object");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

test("an unreachable embedding adapter is named instead of surfacing as a bare fetch failure", async () => {
  const port = await closedPort(), store = new RoleStore(join(mkdtempSync(join(tmpdir(), "supercuts-memwal-")), "state.sqlite"), randomBytes(32));
  const memory = new ManualMemory(store, { key: "11".repeat(32), accountId: "0x1", serverUrl: `http://127.0.0.1:${port}`, namespace: "test", suiPrivateKey: Ed25519Keypair.generate().getSecretKey(), embeddingApiBase: `http://127.0.0.1:${port}/v1`, embeddingApiKey: "x", embeddingModel: "m" } as never);
  try {
    await assert.rejects(() => memory.recall("privacy rule"), (error: Error & { code?: string }) => {
      assert.equal(error.code, "MEMORY_ENDPOINT_UNREACHABLE");
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}/v1`));
      assert.match(error.message, /supercuts-embedding-adapter/);
      return true;
    });
  } finally { memory.destroy(); store.close(); }
});
