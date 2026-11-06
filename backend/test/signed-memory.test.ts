import assert from "node:assert/strict";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  memorySignerAddress,
  openMemoryText,
  sealMemoryText,
} from "../src/memwal.js";
import type { SettlementMemoryV1 } from "../src/settlement.js";

const memory: SettlementMemoryV1 = {
  version: "supercuts.settlement-memory.v1",
  kind: "outcome",
  provenance: "verified_outcome",
  scope: { counterparty: "seller-a", capabilityClass: "artifact.generation" },
  createdAt: 1_700_000_000_000,
  evidenceHash: "ab".repeat(32),
  signal: {
    outcome: "succeeded",
    amount: "10",
    rail: "shielded",
    latencyMs: 1200,
  },
};

test("trusted memories are sealed with the owner memory key and verify on any machine", () => {
  const owner = Ed25519Keypair.generate(),
    secret = owner.getSecretKey();
  const text = sealMemoryText(memory, secret);
  const opened = openMemoryText(text);
  assert.deepEqual(opened.memory, memory);
  assert.equal(opened.signedBy, owner.toSuiAddress());
  assert.equal(memorySignerAddress(secret), owner.toSuiAddress());
});

test("tampered or re-signed memories do not keep the owner's authority", () => {
  const owner = Ed25519Keypair.generate(),
    other = Ed25519Keypair.generate();
  const envelope = JSON.parse(sealMemoryText(memory, owner.getSecretKey())) as {
    memory: SettlementMemoryV1;
  };
  envelope.memory = {
    ...envelope.memory,
    signal: { ...envelope.memory.signal, outcome: "failed" },
  };
  assert.equal(openMemoryText(JSON.stringify(envelope)).signedBy, undefined);
  assert.notEqual(
    openMemoryText(sealMemoryText(memory, other.getSecretKey())).signedBy,
    owner.toSuiAddress(),
  );
});

test("agent observations and legacy plain memories open without a signer", () => {
  const plain = openMemoryText(
    JSON.stringify({
      ...memory,
      provenance: "agent_observation",
      evidenceHash: undefined,
    }),
  );
  assert.equal(plain.signedBy, undefined);
  assert.equal(
    (plain.memory as SettlementMemoryV1).provenance,
    "agent_observation",
  );
  assert.throws(() => openMemoryText("not json"));
});

test("signed envelopes carry a plain-language summary for embedding recall", () => {
  const owner = Ed25519Keypair.generate();
  const envelope = JSON.parse(sealMemoryText(memory, owner.getSecretKey())) as { summary: string };
  assert.match(envelope.summary, /succeeded/); assert.match(envelope.summary, /seller-a/); assert.match(envelope.summary, /artifact\.generation/);
  assert.equal(openMemoryText(JSON.stringify(envelope)).signedBy, owner.toSuiAddress(), "the summary is outside the signed payload");
});
