import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "..");
const config = JSON.parse(readFileSync(resolve(root, "build/adversarial/config.json")));
const values = JSON.parse(readFileSync(resolve(root, "build/adversarial/fixtures/public.json")));
const proof = readFileSync(resolve(root, "build/adversarial/proofs/withdraw/proof.bin"));
const vector = (bytes) => `[${[...bytes].join(",")}]`;
const field = (value) => Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex");
const mutate = (value) => (BigInt(value) + 1n).toString();
const state = () => {
  const result = spawnSync("sui", ["client", "object", config.poolId, "--json"], { cwd: repository, encoding: "utf8" });
  const object = JSON.parse(result.stdout);
  return { custody: object.content.custody, root: object.content.root, nextLeaf: object.content.next_leaf, acceptedRoots: object.content.accepted_roots.size, spentNotes: object.content.spent_notes.size, consumedDeals: object.content.consumed_deals.size };
};
function args(overrides = {}) {
  const input = { root: values.finalRoot, nullifier: values.withdrawalNullifier, recipient: values.recipient, amount: values.paymentAmount, proof, ...overrides };
  return [
    "client", "ptb",
    "--make-move-vec", "<u8>", vector(field(input.root)), "--assign", "root",
    "--make-move-vec", "<u8>", vector(field(input.nullifier)), "--assign", "noteNull",
    "--make-move-vec", "<u8>", vector(input.proof), "--assign", "proof",
    "--move-call", `${config.packageId}::pool::withdraw`, `<${config.coinType}>`,
    `@${config.poolId}`, "root", "noteNull", `@${input.recipient}`, String(input.amount), "proof",
    "--gas-budget", "100000000", "--json",
  ];
}
function execute(command) {
  const result = spawnSync("sui", command, { cwd: repository, encoding: "utf8" });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { status: result.status === 0 ? "success" : "failure", digest: output.match(/transaction '([A-Za-z0-9]+)'/i)?.[1] ?? output.match(/Transaction Digest:\s*([A-Za-z0-9]+)/i)?.[1] ?? null, error: result.status === 0 ? null : output.trim().slice(-1000) };
}
const badProof = Buffer.from(proof); badProof[0] ^= 1;
const wrongRecipient = `0x${"01".padStart(64, "0")}`;
const cases = [
  ["amount", { amount: (BigInt(values.paymentAmount) + 1n).toString() }],
  ["recipient", { recipient: wrongRecipient }],
  ["accepted-root", { root: mutate(values.finalRoot) }],
  ["note-nullifier", { nullifier: mutate(values.withdrawalNullifier) }],
  ["withdraw-proof", { proof: badProof }],
];
const rejected = [];
for (const [name, override] of cases) {
  const before = state();
  const result = execute(args(override));
  const after = state();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (result.status !== "failure" || !unchanged) throw new Error(`${name} did not fail closed`);
  rejected.push({ name, ...result, stateUnchanged: unchanged });
}
const evidencePath = resolve(root, "build/adversarial/evidence.json");
const evidence = JSON.parse(readFileSync(evidencePath));
evidence.withdrawalMutations = rejected;
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ poolId: config.poolId, withdrawalMutations: rejected }, null, 2));
