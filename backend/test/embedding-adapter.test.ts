import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  TARGET_DIMENSIONS,
  createEmbeddingAdapter,
  padEmbedding,
  transformEmbeddingResponse,
} from "../src/embedding-adapter.js";

test("pads shorter vectors, passes full vectors, and rejects oversized or empty ones", () => {
  const padded = padEmbedding(Array(768).fill(0.5));
  assert.equal(padded.length, TARGET_DIMENSIONS);
  assert.ok(padded.slice(768).every((value) => value === 0));
  assert.equal(
    padEmbedding(Array(TARGET_DIMENSIONS).fill(1)).length,
    TARGET_DIMENSIONS,
  );
  assert.throws(() => padEmbedding(Array(TARGET_DIMENSIONS + 1).fill(1)));
  assert.throws(() => padEmbedding([]));
  assert.throws(
    () =>
      transformEmbeddingResponse({
        data: [{ embedding: [1] }, { embedding: [1, 2] }],
      }),
    /inconsistent/,
  );
});

test("adapter proxies to the upstream model and pads its response", async () => {
  let forwarded: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    forwarded = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ index: 0, embedding: Array(768).fill(1) }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const server = createEmbeddingAdapter({
    fetchImpl,
    upstreamBaseUrl: "http://upstream.test/v1",
    upstreamModel: "embeddinggemma",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "embeddinggemma-1536", input: "hello" }),
    });
    const body = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    assert.equal(response.status, 200);
    assert.equal(body.data[0]!.embedding.length, TARGET_DIMENSIONS);
    assert.equal(
      forwarded?.model,
      "embeddinggemma",
      "the client label is replaced by the upstream model",
    );
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    server.close();
  }
});
