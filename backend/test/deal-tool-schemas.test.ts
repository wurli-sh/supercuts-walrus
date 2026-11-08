import assert from "node:assert/strict";
import test from "node:test";
import { toolSchema, validateToolArguments } from "../src/mandate.js";

test("every deal tool keyed by operationId accepts exactly the argument its handler reads", () => {
  for (const name of ["deal.get", "deal.resume", "deal.reconcile"]) {
    const spec = toolSchema(name);
    assert.doesNotThrow(() => validateToolArguments(spec, { operationId: "op-1" }), `${name} must accept { operationId }`);
    assert.deepEqual(spec.inputSchema.required, ["operationId"], `${name} must not demand a second operation-id`);
  }
});
