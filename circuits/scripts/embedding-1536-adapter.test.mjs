import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_DIMENSIONS, TARGET_DIMENSIONS, createEmbeddingAdapter, padEmbedding, transformEmbeddingResponse } from "./embedding-1536-adapter.mjs";

test("pads a local embeddinggemma vector to the relayer dimension", () => {
  const source = Array.from({ length: SOURCE_DIMENSIONS }, (_, index) => index / 100);
  const padded = padEmbedding(source);
  assert.equal(padded.length, TARGET_DIMENSIONS);
  assert.deepEqual(padded.slice(0, SOURCE_DIMENSIONS), source);
  assert.ok(padded.slice(SOURCE_DIMENSIONS).every((value) => value === 0));
});

test("preserves OpenAI response fields while padding every vector", () => {
  const result = transformEmbeddingResponse({ object: "list", model: "embeddinggemma", data: [{ object: "embedding", index: 0, embedding: Array(SOURCE_DIMENSIONS).fill(1) }], usage: { total_tokens: 2 } });
  assert.equal(result.model, "embeddinggemma");
  assert.equal(result.usage.total_tokens, 2);
  assert.equal(result.data[0].embedding.length, TARGET_DIMENSIONS);
});

test("rejects a source model with the wrong output dimension", () => {
  assert.throws(() => padEmbedding(Array(4).fill(0)), /768-dimensional/);
});

test("serves a 1536-dimensional OpenAI-compatible embedding response", async () => {
  let upstreamRequest;
  const server = createEmbeddingAdapter({
    upstreamBaseUrl: "http://local-upstream/v1",
    upstreamModel: "embeddinggemma",
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return new Response(JSON.stringify({ data: [{ embedding: Array(SOURCE_DIMENSIONS).fill(0.25) }] }), { status: 200 });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-placeholder" },
      body: JSON.stringify({ model: "embeddinggemma-1536", input: "private negotiation" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data[0].embedding.length, TARGET_DIMENSIONS);
    assert.equal(upstreamRequest.url, "http://local-upstream/v1/embeddings");
    assert.deepEqual(JSON.parse(upstreamRequest.options.body), { model: "embeddinggemma", input: "private negotiation" });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
