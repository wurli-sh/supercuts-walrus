/**
 * OpenAI-compatible embedding adapter for a 768-dimensional local model.
 *
 * The Walrus Mainnet relayer indexes 1536-dimensional embeddings. This proxy
 * forwards requests to a local OpenAI-compatible embedding endpoint and
 * zero-pads each 768-dimensional result to 1536 dimensions. Zero-padding
 * preserves cosine similarity and Euclidean distance when all writes and
 * searches use this same endpoint.
 */
import { createServer } from "node:http";

export const SOURCE_DIMENSIONS = 768;
export const TARGET_DIMENSIONS = 1536;

export function padEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length !== SOURCE_DIMENSIONS) {
    throw new Error(`expected a ${SOURCE_DIMENSIONS}-dimensional embedding, received ${Array.isArray(embedding) ? embedding.length : "a non-array value"}`);
  }
  if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("upstream embedding contains a non-finite value");
  }
  return [...embedding, ...Array(TARGET_DIMENSIONS - SOURCE_DIMENSIONS).fill(0)];
}

export function transformEmbeddingResponse(payload) {
  if (!payload || !Array.isArray(payload.data)) throw new Error("upstream response has no data array");
  return { ...payload, data: payload.data.map((item) => ({ ...item, embedding: padEmbedding(item?.embedding) })) };
}

export function createEmbeddingAdapter({ fetchImpl = fetch, upstreamBaseUrl, upstreamApiKey, upstreamModel }) {
  if (!upstreamBaseUrl) throw new Error("EMBEDDING_UPSTREAM_BASE_URL is required");
  if (!upstreamModel) throw new Error("EMBEDDING_UPSTREAM_MODEL is required");
  const endpoint = `${upstreamBaseUrl.replace(/\/$/, "")}/embeddings`;
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", sourceDimensions: SOURCE_DIMENSIONS, targetDimensions: TARGET_DIMENSIONS }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/embeddings") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const requested = JSON.parse(body);
      const upstreamResponse = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(upstreamApiKey ? { authorization: `Bearer ${upstreamApiKey}` } : {}) },
        body: JSON.stringify({ ...requested, model: upstreamModel }),
      });
      const upstreamBody = await upstreamResponse.text();
      if (!upstreamResponse.ok) {
        response.writeHead(upstreamResponse.status, { "content-type": "application/json" });
        response.end(upstreamBody);
        return;
      }
      const result = transformEmbeddingResponse(JSON.parse(upstreamBody));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "embedding adapter failed" } }));
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.EMBEDDING_ADAPTER_PORT ?? 8787);
  const server = createEmbeddingAdapter({
    upstreamBaseUrl: process.env.EMBEDDING_UPSTREAM_BASE_URL,
    upstreamApiKey: process.env.EMBEDDING_UPSTREAM_API_KEY,
    upstreamModel: process.env.EMBEDDING_UPSTREAM_MODEL ?? "embeddinggemma",
  });
  server.listen(port, "127.0.0.1", () => console.log(`1536-dimensional embedding adapter listening at http://127.0.0.1:${port}/v1`));
}
