import assert from "node:assert/strict";
import test from "node:test";
import { mergeRecalls, scopedRecallQueries } from "../src/phase3.js";
import { toolSchema } from "../src/mandate.js";

test("memory.recall also searches the capability scope the planner uses", () => {
  const manifest = { capabilityId: "confidential-analysis-v2", capability: "sui.confidential-analysis", sellerId: "0xseller" };
  assert.deepEqual(scopedRecallQueries("my privacy preferences", manifest as never), ["my privacy preferences", "confidential-analysis-v2 sui.confidential-analysis 0xseller"]);
  assert.deepEqual(scopedRecallQueries("my privacy preferences"), ["my privacy preferences"]);
});

test("recall results from several queries keep each blob once at its closest distance", () => {
  const merged = mergeRecalls([[{ blobId: "a", text: "A", distance: 0.6 }, { blobId: "b", text: "B", distance: 0.2 }], [{ blobId: "a", text: "A", distance: 0.1 }]]);
  assert.deepEqual(merged, [{ blobId: "a", text: "A", distance: 0.1 }, { blobId: "b", text: "B", distance: 0.2 }]);
});

test("memory.recall accepts an optional manifest", () => {
  const schema = toolSchema("memory.recall").inputSchema;
  assert.equal(schema.properties.manifest?.type, "object");
  assert.deepEqual(schema.required, ["query"]);
});
