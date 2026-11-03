import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { SupercutsError } from "./errors.js";
import { SellerRuntime, type ServiceRequest } from "./seller-runtime.js";

interface StdioRequest { id: string; method: "catalog" | "fulfill"; params?: Record<string, unknown>; }

/** Local JSONL adapter. The host owns the seller signer, payment verifier,
 * handler, and Walrus transport; callers receive only public registration
 * metadata and encrypted delivery references. */
export async function serveSellerStdio(runtime: SellerRuntime, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  const send = (value: unknown) => { output.write(`${JSON.stringify(value)}\n`); };
  for await (const line of lines) {
    queue = queue.then(async () => {
      let id: string | null = null;
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new SupercutsError("SELLER_REQUEST_INVALID", "seller stdio request exceeds 1 MiB");
        const parsed = JSON.parse(line) as StdioRequest;
        if (!parsed || typeof parsed.id !== "string" || !parsed.id || !["catalog", "fulfill"].includes(parsed.method)) throw new SupercutsError("SELLER_REQUEST_INVALID", "seller stdio method or request ID is invalid");
        id = parsed.id;
        const result = parsed.method === "catalog" ? { capabilities: runtime.catalog() } : await runtime.fulfill(parsed.params as unknown as ServiceRequest);
        send({ id, ok: true, result });
      } catch (error) {
        send({ id, ok: false, error: { code: error instanceof SupercutsError ? error.code : "SELLER_REQUEST_FAILED", message: error instanceof SupercutsError ? error.message : "seller request failed" } });
      }
    });
  }
  await queue;
}
