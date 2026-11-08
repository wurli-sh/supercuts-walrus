import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryFlusher } from "../src/memory-flusher.js";

test("kick runs one flush at a time and drain waits for the one in flight", async () => {
  let runs = 0, release: () => void = () => {};
  const flusher = createMemoryFlusher(async () => { runs += 1; await new Promise<void>((done) => { release = done; }); }, () => {});
  flusher.kick(); flusher.kick();
  assert.equal(runs, 1, "a second kick while flushing is a no-op");
  let drained = false; const draining = flusher.drain(1_000).then(() => { drained = true; });
  await new Promise((done) => setImmediate(done));
  assert.equal(drained, false, "drain waits for the in-flight write");
  release(); await draining;
  assert.equal(drained, true);
});

test("drain gives up after its timeout and flush errors are reported, not thrown", async () => {
  const errors: unknown[] = [];
  const stuck = createMemoryFlusher(() => new Promise<void>(() => {}), (error) => errors.push(error));
  stuck.kick();
  const started = Date.now(); await stuck.drain(50);
  assert.ok(Date.now() - started < 1_000);
  const failing = createMemoryFlusher(async () => { throw Object.assign(new Error("x"), { code: "MEMORY_ENDPOINT_UNREACHABLE" }); }, (error) => errors.push(error));
  failing.kick(); await failing.drain(1_000);
  assert.equal((errors[0] as { code?: string }).code, "MEMORY_ENDPOINT_UNREACHABLE");
});
