#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadStateKey } from "./config.js";
import { Phase3App } from "./phase3.js";
import { LiveRuntime, type LiveRuntimeProfile } from "./live-runtime.js";
import { RoleStore } from "./store.js";
import { V2ExitQueue } from "./v2-exits.js";
import { V2ExitRelayer, type V2ExitRequest, type V2RelayerPin } from "./v2-exit-relayer.js";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value) throw Error("expected --name value arguments");
  args.set(name.slice(2), value);
}
const required = (name: string): string => args.get(name) ?? (() => { throw Error(`--${name} is required`); })();
const sellerHome = resolve(required("seller-home")), relayerHome = resolve(required("relayer-home"));
const pin = JSON.parse(readFileSync(resolve(required("config")), "utf8")) as V2RelayerPin;
const operationId = required("operation-id"), evidencePath = resolve(required("evidence-file"));
const pause = (milliseconds: number): Promise<void> => new Promise((done) => setTimeout(done, milliseconds));

function requestFromStore(app: Phase3App): V2ExitRequest {
  const encoded = app.store.getSecret(`v2-exit-request:${operationId}`);
  if (!encoded) throw Error("queued exit request is unavailable in the seller store");
  const raw = JSON.parse(encoded.toString()) as Record<string, string | boolean>;
  const bytes32 = (name: string): Buffer => Buffer.from(String(raw[name] ?? "").replace(/^0x/, ""), "hex");
  return { operationId: String(raw.operationId), root: bytes32("root"), noteNullifier: bytes32("noteNullifier"),
    recipient: String(raw.recipient), amount: BigInt(String(raw.amount)), exactExit: raw.exactExit === true,
    changeCommitment: bytes32("changeCommitment"), newRoot: bytes32("newRoot"), newIndex: BigInt(String(raw.newIndex)),
    proof: Buffer.from(String(raw.proof), "base64") };
}

async function attempt(): Promise<boolean> {
  if (existsSync(evidencePath)) return true;
  const seller = new Phase3App(sellerHome);
  const relayerStore = new RoleStore(join(relayerHome, "state.sqlite"), loadStateKey(join(relayerHome, "state.key")));
  try {
    const queue = new V2ExitQueue(seller.store), scheduled = queue.get(operationId);
    if (!scheduled) throw Error("queued exit does not exist");
    if (scheduled.status === "queued") queue.assertDue(operationId);
    else if (scheduled.status !== "finalized") throw Error("exit is awaiting an unresolved submission");
    if (!seller.profile.live) throw Error("seller profile has no live Testnet deployment");
    const relayer = new V2ExitRelayer(relayerStore, pin), runtime = await LiveRuntime.create(seller.profile as LiveRuntimeProfile, seller.store);
    let request = requestFromStore(seller);
    const existing = relayerStore.db.prepare("SELECT digest FROM v2_relay_journal WHERE operation_id=?").get(request.operationId) as { digest: string } | undefined;
    if (!existing) {
      const state = await runtime.index.sync();
      if (Buffer.from(request.root).toString("hex") !== state.root.toString(16).padStart(64, "0")) {
        await runtime.refreshV2Exit(operationId);
        request = requestFromStore(seller);
      }
    }
    const relayed = await relayer.submit(request);
    const parameters = { "exit-id": operationId, digest: relayed.digest };
    const token = seller.approve(seller.preview("wallet.exit.finalize", parameters).challengeId);
    const finalized = (await seller.execute("wallet.exit.finalize", { ...parameters, "approval-token": token.token })).data;
    const evidence = { schema: "supercuts.v2.exit-completion.v1", operationId, relayer: relayed.relayer, digest: relayed.digest,
      checkpoint: relayed.checkpoint, payoutAddress: scheduled.payoutAddress, amount: scheduled.amount.toString(),
      exactExit: scheduled.exactExit, tatumVerified: finalized.tatumVerified, finalized: finalized.finalized, completedAt: new Date().toISOString() };
    const temporary = `${evidencePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, evidencePath);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    return true;
  } finally { relayerStore.close(); seller.close(); }
}

const window = new Phase3App(sellerHome);
let windowEnd: number;
try { windowEnd = new V2ExitQueue(window.store).get(operationId)?.windowEnd ?? 0; } finally { window.close(); }
if (!windowEnd) throw Error("queued exit does not exist");
while (Date.now() < windowEnd) {
  try { if (await attempt()) process.exit(0); }
  catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`${JSON.stringify({ operationId, error: message, at: new Date().toISOString() })}\n`);
  }
  await pause(Math.min(20_000, Math.max(1_000, windowEnd - Date.now())));
}
throw Error("approved exit window closed before finality was recorded");
