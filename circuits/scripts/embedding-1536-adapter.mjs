/**
 * OpenAI-compatible embedding adapter for local models.
 *
 * The Walrus Mainnet relayer indexes 1536-dimensional embeddings. This proxy
 * forwards requests to a local OpenAI-compatible embedding endpoint and
 * zero-pads shorter results to 1536 dimensions. Zero-padding
 * preserves cosine similarity and Euclidean distance when all writes and
 * searches use this same endpoint.
 */
import { createServer } from "node:http";

export const SOURCE_DIMENSIONS = 768;
export const TARGET_DIMENSIONS = 1536;

export function padEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length < 1 || embedding.length > TARGET_DIMENSIONS) {
    throw new Error(`expected an embedding with 1 to ${TARGET_DIMENSIONS} dimensions, received ${Array.isArray(embedding) ? embedding.length : "a non-array value"}`);
  }
  if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("upstream embedding contains a non-finite value");
  }
  return [...embedding, ...Array(TARGET_DIMENSIONS - embedding.length).fill(0)];
}

export function transformEmbeddingResponse(payload) {
  if (!payload || !Array.isArray(payload.data) || !payload.data.length) throw new Error("upstream response has no embeddings");
  const dimension = payload.data[0]?.embedding?.length;
  if (payload.data.some((item) => item?.embedding?.length !== dimension)) throw new Error("upstream embeddings have inconsistent dimensions");
  return { ...payload, data: payload.data.map((item) => ({ ...item, embedding: padEmbedding(item?.embedding) })) };
}

export function createEmbeddingAdapter({ fetchImpl = fetch, upstreamBaseUrl, upstreamApiKey, upstreamModel }) {
  if (!upstreamBaseUrl) throw new Error("EMBEDDING_UPSTREAM_BASE_URL is required");
  if (!upstreamModel) throw new Error("EMBEDDING_UPSTREAM_MODEL is required");
  const endpoint = `${upstreamBaseUrl.replace(/\/$/, "")}/embeddings`;
  let sourceDimensions;
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", targetDimensions: TARGET_DIMENSIONS }));
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
      const payload = JSON.parse(upstreamBody);
      const result = transformEmbeddingResponse(payload);
      const dimension = payload.data[0].embedding.length;
      if (sourceDimensions !== undefined && sourceDimensions !== dimension) throw new Error("upstream embedding dimensions changed");
      sourceDimensions = dimension;
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
