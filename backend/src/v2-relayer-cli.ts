#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadStateKey } from "./config.js";
import { RoleStore } from "./store.js";
import { V2ExitRelayer, type V2RelayerPin } from "./v2-exit-relayer.js";

const [command, ...words] = process.argv.slice(2);
const args = new Map<string, string>();
for (let index = 0; index < words.length; index += 2) {
  if (!words[index]?.startsWith("--") || !words[index + 1]) throw Error("expected --name value arguments");
  args.set(words[index]!.slice(2), words[index + 1]!);
}
const required = (name: string) => args.get(name) ?? (() => { throw Error(`--${name} is required`); })();
const stateDir = resolve(required("state-dir"));
const config = JSON.parse(readFileSync(resolve(required("config")), "utf8")) as V2RelayerPin;
const store = new RoleStore(join(stateDir, "state.sqlite"), loadStateKey(join(stateDir, "state.key")));
try {
  const relayer = new V2ExitRelayer(store, config);
  if (command === "doctor") console.log(JSON.stringify(await relayer.doctor()));
  else if (command === "submit") {
    const requestPath = resolve(required("request-file"));
    if ((statSync(requestPath).mode & 0o077) !== 0) throw Error("request file must be owner-only");
    const raw = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, string | boolean>;
    const bytes32 = (name: string) => Buffer.from(String(raw[name] ?? "").replace(/^0x/, ""), "hex");
    const result = await relayer.submit({ operationId: String(raw.operationId), root: bytes32("root"), noteNullifier: bytes32("noteNullifier"),
      recipient: String(raw.recipient), amount: BigInt(String(raw.amount)), exactExit: raw.exactExit === true,
      changeCommitment: bytes32("changeCommitment"), newRoot: bytes32("newRoot"), newIndex: BigInt(String(raw.newIndex)),
      proof: Buffer.from(String(raw.proof), "base64") });
    console.log(JSON.stringify(result));
  } else throw Error("use doctor or submit");
} finally { store.close(); }
