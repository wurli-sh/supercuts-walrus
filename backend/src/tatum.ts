import http2 from "node:http2";
import { GrpcTypes } from "@mysten/sui/grpc";
import { fail, SupercutsError } from "./errors.js";

type BinaryMessage = { toBinary(value: object): Uint8Array; fromBinary(value: Uint8Array): unknown };

function authority(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) fail("TATUM_ENDPOINT_INVALID", "Tatum endpoint must use HTTPS except on loopback");
  return url.origin;
}
function frame(bytes: Uint8Array): Buffer {
  const value = Buffer.from(bytes); const result = Buffer.alloc(5 + value.length);
  result.writeUInt32BE(value.length, 1); value.copy(result, 5); return result;
}
function unframe(body: Buffer): Buffer[] {
  const values: Buffer[] = []; let offset = 0;
  while (offset < body.length) {
    if (body[offset] !== 0 || offset + 5 > body.length) fail("TATUM_GRPC_FRAME", "compressed or truncated gRPC response");
    const size = body.readUInt32BE(offset + 1); offset += 5;
    if (offset + size > body.length) fail("TATUM_GRPC_FRAME", "truncated gRPC response payload");
    values.push(body.subarray(offset, offset + size)); offset += size;
  }
  return values;
}

/** Minimal native HTTP/2 adapter because Tatum exposes gRPC, not gRPC-web. */
export class TatumLedger {
  constructor(private readonly endpoint: string, private readonly apiKey: string) {
    if (!apiKey || apiKey.length > 4096) fail("TATUM_CONFIG_INVALID", "Tatum API key is missing or too large");
    authority(endpoint);
  }
  async unary<Request extends object, Response>(method: string, requestType: BinaryMessage, responseType: BinaryMessage, message: Request): Promise<Response> {
    const result = await this.call(method, frame(requestType.toBinary(message)));
    const messages = unframe(result.body);
    if (messages.length !== 1) fail("TATUM_GRPC_FRAME", `${method} returned ${messages.length} messages`);
    return responseType.fromBinary(messages[0]!) as Response;
  }
  async stream<Request extends object, Response>(method: string, requestType: BinaryMessage, responseType: BinaryMessage, message: Request): Promise<Response[]> {
    const result = await this.call(method, frame(requestType.toBinary(message)));
    return unframe(result.body).map((value) => responseType.fromBinary(value) as Response);
  }
  private async call(method: string, payload: Buffer): Promise<{ body: Buffer }> {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) fail("TATUM_METHOD_INVALID", "invalid gRPC method name");
    const client = http2.connect(authority(this.endpoint));
    return await new Promise((resolve, reject) => {
      const request = client.request({ ":method": "POST", ":path": `/sui.rpc.v2.LedgerService/${method}`, "content-type": "application/grpc", te: "trailers", "x-api-key": this.apiKey });
      const chunks: Buffer[] = []; let size = 0; let status: number | undefined; let grpcStatus: string | undefined; let done = false;
      const rejectOnce = (error: Error) => { if (done) return; done = true; request.close(http2.constants.NGHTTP2_CANCEL); client.close(); reject(error); };
      request.setTimeout(20_000, () => rejectOnce(new SupercutsError("TATUM_TIMEOUT", `${method} timed out`)));
      request.on("response", (headers) => { status = Number(headers[":status"]); if (headers["grpc-status"] !== undefined) grpcStatus = String(headers["grpc-status"]); });
      request.on("trailers", (headers) => { grpcStatus = String(headers["grpc-status"]); });
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 32 * 1024 * 1024) return rejectOnce(new SupercutsError("TATUM_RESPONSE_TOO_LARGE", `${method} exceeded 32 MiB`)); chunks.push(chunk); });
      request.on("error", (error) => rejectOnce(error));
      request.on("end", () => { if (done) return; done = true; client.close(); if (status !== 200 || grpcStatus !== "0") return reject(new SupercutsError("TATUM_GRPC_ERROR", `${method} failed: HTTP ${status}, gRPC ${grpcStatus}`)); resolve({ body: Buffer.concat(chunks) }); });
      request.end(payload);
    });
  }
  getServiceInfo(): Promise<unknown> { return this.unary("GetServiceInfo", GrpcTypes.GetServiceInfoRequest, GrpcTypes.GetServiceInfoResponse, {}); }
  getTransaction(digest: string): Promise<unknown> { return this.unary("GetTransaction", GrpcTypes.GetTransactionRequest, GrpcTypes.GetTransactionResponse, { digest, readMask: { paths: ["digest", "checkpoint", "effects", "events", "balance_changes"] } }); }
  getObject(objectId: string): Promise<unknown> { return this.unary("GetObject", GrpcTypes.GetObjectRequest, GrpcTypes.GetObjectResponse, { objectId, readMask: { paths: ["object_id", "content", "type"] } }); }
}
