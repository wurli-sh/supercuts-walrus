import assert from "node:assert/strict";
import test from "node:test";
import { SuiTestnetFacilitator } from "../src/facilitator.js";

test("facilitator advertises only Testnet native SUI and protects mutation endpoints", async () => {
  const unavailableClient = {} as any;
  const server = new SuiTestnetFacilitator("k".repeat(32), unavailableClient).createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${origin}/health`); assert.equal(health.status, 200);
    const supported = await (await fetch(`${origin}/supported`)).json() as { kinds: Array<Record<string, unknown>> };
    assert.deepEqual(supported.kinds, [{ x402Version: 2, scheme: "exact", network: "sui:testnet", asset: "0x2::sui::SUI" }]);
    const missing = await fetch(`${origin}/verify`, { method: "POST", body: "{}" }); assert.equal(missing.status, 401);
    const wrong = await fetch(`${origin}/settle`, { method: "POST", headers: { "x-supercuts-facilitator-key": "x".repeat(32) }, body: "{}" }); assert.equal(wrong.status, 401);
    const malformed = await fetch(`${origin}/verify`, { method: "POST", headers: { "x-supercuts-facilitator-key": "k".repeat(32) }, body: "{}" }); assert.equal(malformed.status, 400);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
