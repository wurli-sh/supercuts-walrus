import { createHash } from "node:crypto";
import http2 from "node:http2";
import { GrpcTypes } from "../circuits/node_modules/@mysten/sui/dist/grpc/index.mjs";

const endpoint = process.env.TATUM_SUI_GRPC_ENDPOINT;
const apiKey = process.env.TATUM_API_KEY;
if (!endpoint || !apiKey) throw new Error("TATUM_SUI_GRPC_ENDPOINT and TATUM_API_KEY are required");

const digests = process.argv.slice(2);
if (!digests.length) throw new Error("pass one or more Sui transaction digests");
const authority = endpoint.startsWith("http")
  ? new URL(endpoint).origin
  : `https://${endpoint.replace("://", ":")}`;

async function unary(method, requestType, responseType, message) {
  const payload = Buffer.from(requestType.toBinary(message));
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  const client = http2.connect(authority);
  return await new Promise((resolve, reject) => {
    const request = client.request({
      ":method": "POST",
      ":path": `/sui.rpc.v2.LedgerService/${method}`,
      "content-type": "application/grpc",
      te: "trailers",
      "x-api-key": apiKey,
    });
    const chunks = [];
    let httpStatus;
    let grpcStatus;
    request.setTimeout(20_000, () => request.close(http2.constants.NGHTTP2_CANCEL));
    request.on("response", (headers) => { httpStatus = headers[":status"]; });
    request.on("trailers", (headers) => { grpcStatus = headers["grpc-status"]; });
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      client.close();
      const body = Buffer.concat(chunks);
      if (httpStatus !== 200 || grpcStatus !== "0") return reject(new Error(`${method} failed: HTTP ${httpStatus}, gRPC ${grpcStatus}`));
      if (body.length < 5 || body[0] !== 0 || body.readUInt32BE(1) !== body.length - 5) return reject(new Error(`${method} returned an invalid gRPC frame`));
      const protobuf = body.subarray(5);
      resolve({ decoded: responseType.fromBinary(protobuf), sha256: createHash("sha256").update(protobuf).digest("hex") });
    });
    request.end(frame);
  });
}

const service = await unary("GetServiceInfo", GrpcTypes.GetServiceInfoRequest, GrpcTypes.GetServiceInfoResponse, {});
const transactions = [];
for (const digest of digests) {
  const result = await unary("GetTransaction", GrpcTypes.GetTransactionRequest, GrpcTypes.GetTransactionResponse, {
    digest,
    readMask: { paths: ["digest", "checkpoint", "timestamp"] },
  });
  if (result.decoded.transaction?.digest !== digest) throw new Error(`Tatum returned the wrong transaction for ${digest}`);
  transactions.push({
    digest,
    checkpoint: result.decoded.transaction.checkpoint?.toString(),
    timestampSeconds: result.decoded.transaction.timestamp?.seconds?.toString(),
    responseSha256: result.sha256,
  });
}

const oldestRequired = transactions.reduce((lowest, tx) => BigInt(tx.checkpoint) < lowest ? BigInt(tx.checkpoint) : lowest, BigInt(transactions[0].checkpoint));
const lowestAvailable = service.decoded.lowestAvailableCheckpoint;
const coversRequiredHistory = lowestAvailable !== undefined && lowestAvailable <= oldestRequired;
console.log(JSON.stringify({
  chain: service.decoded.chain,
  chainId: service.decoded.chainId,
  currentCheckpoint: service.decoded.checkpointHeight?.toString(),
  lowestAvailableCheckpoint: lowestAvailable?.toString(),
  oldestRequiredCheckpoint: oldestRequired.toString(),
  coversRequiredHistory,
  serviceResponseSha256: service.sha256,
  transactions,
}, null, 2));
if (!coversRequiredHistory) process.exitCode = 1;
