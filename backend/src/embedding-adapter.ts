#!/usr/bin/env node
/**
 * OpenAI-compatible embedding adapter for local models (`supercuts-embedding-adapter`).
 *
 * Walrus Mainnet Memory indexes 1536-dimensional embeddings. This loopback proxy forwards requests to a
 * local OpenAI-compatible endpoint (Ollama by default) and zero-pads shorter vectors to 1536 dimensions.
 * Zero-padding preserves cosine similarity and Euclidean distance as long as every write and recall uses
 * this same adapter and upstream model. Memory plaintext only reaches the configured upstream.
 */
import { createServer, type Server } from "node:http";
import { isMainModule } from "./main-module.js";

export const TARGET_DIMENSIONS = 1536;
const MAX_REQUEST_BYTES = 1024 * 1024;

export function padEmbedding(embedding: unknown): number[] {
  if (
    !Array.isArray(embedding) ||
    embedding.length < 1 ||
    embedding.length > TARGET_DIMENSIONS
  ) {
    throw new Error(
      `expected an embedding with 1 to ${TARGET_DIMENSIONS} dimensions, received ${Array.isArray(embedding) ? embedding.length : "a non-array value"}`,
    );
  }
  if (
    !embedding.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  )
    throw new Error("upstream embedding contains a non-finite value");
  return [
    ...(embedding as number[]),
    ...Array<number>(TARGET_DIMENSIONS - embedding.length).fill(0),
  ];
}

interface EmbeddingPayload {
  data: Array<{ embedding: unknown } & Record<string, unknown>>;
}

export function transformEmbeddingResponse(payload: unknown): EmbeddingPayload {
  const value = payload as EmbeddingPayload | undefined;
  if (!value || !Array.isArray(value.data) || !value.data.length)
    throw new Error("upstream response has no embeddings");
  const dimension = (value.data[0]?.embedding as unknown[] | undefined)?.length;
  if (
    value.data.some(
      (item) =>
        (item?.embedding as unknown[] | undefined)?.length !== dimension,
    )
  )
    throw new Error("upstream embeddings have inconsistent dimensions");
  return {
    ...value,
    data: value.data.map((item) => ({
      ...item,
      embedding: padEmbedding(item?.embedding),
    })),
  };
}

export interface EmbeddingAdapterOptions {
  upstreamBaseUrl: string;
  upstreamModel: string;
  upstreamApiKey?: string;
  fetchImpl?: typeof fetch;
}

export function createEmbeddingAdapter({
  fetchImpl = fetch,
  upstreamBaseUrl,
  upstreamApiKey,
  upstreamModel,
}: EmbeddingAdapterOptions): Server {
  if (!upstreamBaseUrl)
    throw new Error("EMBEDDING_UPSTREAM_BASE_URL is required");
  if (!upstreamModel) throw new Error("EMBEDDING_UPSTREAM_MODEL is required");
  const endpoint = `${upstreamBaseUrl.replace(/\/$/, "")}/embeddings`;
  let sourceDimensions: number | undefined;
  const send = (
    response: import("node:http").ServerResponse,
    status: number,
    body: unknown,
  ) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  return createServer(async (request, response) => {
    // Loopback only: reject other Host headers so a DNS-rebinding page cannot drive the local embedding model.
    const host = (request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return send(response, 403, { error: { message: "loopback host required" } });
    if (request.method === "GET" && request.url === "/health")
      return send(response, 200, {
        status: "ok",
        targetDimensions: TARGET_DIMENSIONS,
        upstreamModel,
      });
    if (request.method !== "POST" || request.url !== "/v1/embeddings")
      return send(response, 404, { error: { message: "not found" } });
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > MAX_REQUEST_BYTES)
          throw new Error("embedding request is too large");
      }
      const requested = JSON.parse(body) as Record<string, unknown>;
      const upstream = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(upstreamApiKey
            ? { authorization: `Bearer ${upstreamApiKey}` }
            : {}),
        },
        body: JSON.stringify({ ...requested, model: upstreamModel }),
        signal: AbortSignal.timeout(60_000),
      });
      const upstreamBody = await upstream.text();
      if (!upstream.ok) return send(response, upstream.status, upstreamBody);
      const payload = JSON.parse(upstreamBody) as EmbeddingPayload,
        result = transformEmbeddingResponse(payload);
      const dimension = (payload.data[0]!.embedding as unknown[]).length;
      if (sourceDimensions !== undefined && sourceDimensions !== dimension)
        throw new Error("upstream embedding dimensions changed");
      sourceDimensions = dimension;
      send(response, 200, result);
    } catch (error) {
      send(response, 502, {
        error: {
          message:
            error instanceof Error ? error.message : "embedding adapter failed",
        },
      });
    }
  });
}

if (isMainModule(import.meta.url)) {
  const port = Number(process.env.EMBEDDING_ADAPTER_PORT ?? 8787);
  const upstreamBaseUrl =
    process.env.EMBEDDING_UPSTREAM_BASE_URL ?? "http://127.0.0.1:11434/v1";
  const upstreamModel =
    process.env.EMBEDDING_UPSTREAM_MODEL ?? "embeddinggemma";
  const server = createEmbeddingAdapter({
    upstreamBaseUrl,
    upstreamModel,
    ...(process.env.EMBEDDING_UPSTREAM_API_KEY
      ? { upstreamApiKey: process.env.EMBEDDING_UPSTREAM_API_KEY }
      : {}),
  });
  server.listen(port, "127.0.0.1", () =>
    process.stdout.write(
      `${JSON.stringify({ ok: true, listening: `http://127.0.0.1:${port}/v1`, upstream: upstreamBaseUrl, upstreamModel, targetDimensions: TARGET_DIMENSIONS, memoryConfig: { embeddingApiBase: `http://127.0.0.1:${port}/v1`, embeddingModel: `${upstreamModel}-1536` } })}\n`,
    ),
  );
}
