import http2 from "node:http2";

const endpoint = process.env.TATUM_SUI_GRPC_ENDPOINT;
const apiKey = process.env.TATUM_API_KEY;
if (!endpoint || !apiKey) throw new Error("TATUM_SUI_GRPC_ENDPOINT and TATUM_API_KEY are required");

function normalizeEndpoint(value) {
  if (value.startsWith("https://") || value.startsWith("http://")) return new URL(value);
  // Tatum's documented form is often host://port rather than a URI.
  return new URL(`https://${value.replace("://", ":")}`);
}

const url = normalizeEndpoint(endpoint);
const client = http2.connect(`${url.protocol}//${url.hostname}:${url.port || 443}`);
const request = client.request({
  ":method": "POST",
  ":path": "/sui.rpc.v2.LedgerService/GetCheckpoint",
  "content-type": "application/grpc",
  te: "trailers",
  "x-api-key": apiKey,
});
let status;
let trailers = {};
const chunks = [];
request.setTimeout(20_000, () => request.close(http2.constants.NGHTTP2_CANCEL));
request.on("response", (headers) => { status = headers[":status"]; });
request.on("trailers", (value) => { trailers = value; });
request.on("data", (chunk) => chunks.push(chunk));
request.on("error", (error) => {
  console.error(`Tatum gRPC request failed: ${error.message}`);
  process.exitCode = 1;
});
request.on("end", () => {
  const body = Buffer.concat(chunks);
  const framingValid = body.length >= 5 && body[0] === 0 && body.readUInt32BE(1) === body.length - 5;
  console.log(JSON.stringify({
    service: "sui.rpc.v2.LedgerService/GetCheckpoint",
    httpStatus: status,
    grpcStatus: trailers["grpc-status"],
    responseBytes: body.length,
    framingValid,
  }, null, 2));
  if (status !== 200 || trailers["grpc-status"] !== "0" || !framingValid) process.exitCode = 1;
  client.close();
});
// A gRPC message with an empty protobuf payload.
request.end(Buffer.from([0, 0, 0, 0, 0]));
