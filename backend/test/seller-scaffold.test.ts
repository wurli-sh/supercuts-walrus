import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scaffoldSeller } from "../src/seller-scaffold.js";

test("seller scaffold emits owner-only runnable templates without embedding facilitator secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "supercuts-seller-scaffold-")), output = join(root, "offer");
  const result = scaffoldSeller({ home: join(root, "seller"), output, "capability-id": "risk-brief", capability: "sui.risk-brief", description: "Risk brief", origin: "http://127.0.0.1:8899", price: "1000000", rails: "x402", "expires-in-days": "7" });
  const spec = JSON.parse(readFileSync(join(output, "capability.json"), "utf8")) as { expiresAt: number; supportedRails: string[] };
  const service = JSON.parse(readFileSync(join(output, "seller-service.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(spec.supportedRails, ["x402"]);
  assert.ok(spec.expiresAt > Date.now());
  assert.equal(service.facilitatorKey, undefined);
  assert.equal(service.facilitatorKeyEnv, "FACILITATOR_SHARED_KEY");
  assert.equal(statSync(output).mode & 0o077, 0);
  for (const name of ["capability.json", "handler.mjs", "seller-service.json"]) assert.equal(statSync(join(output, name)).mode & 0o077, 0);
  assert.equal((result.nextCommands as string[]).length, 2);
});
