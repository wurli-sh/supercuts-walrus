import assert from "node:assert/strict";
import test from "node:test";
import { createWarmer } from "../src/warm.js";

test("warmer pings /health in the background, at most once per interval and never concurrently", async () => {
  const calls: string[] = []; let clock = 0, release: () => void = () => {};
  const fetchImpl = (async (url: string) => { calls.push(url); await new Promise<void>((done) => { release = done; }); return new Response("ok"); }) as unknown as typeof fetch;
  const warm = createWarmer("https://facilitator.example/", { minIntervalMs: 60_000, fetchImpl, now: () => clock });
  warm(); warm();
  assert.deepEqual(calls, ["https://facilitator.example/health"], "one ping while one is in flight");
  release(); await new Promise((done) => setImmediate(done));
  clock = 30_000; warm();
  assert.equal(calls.length, 1, "throttled inside the interval");
  clock = 61_000; warm();
  assert.equal(calls.length, 2, "pings again after the interval");
  release(); await new Promise((done) => setImmediate(done));
});

test("a failing ping never throws into the request path", async () => {
  const fetchImpl = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const warm = createWarmer("https://facilitator.example", { fetchImpl });
  assert.doesNotThrow(() => warm());
  await new Promise((done) => setImmediate(done));
});
