#!/usr/bin/env node
import { Phase3App, errorOutput, homePath, initialize, parseArgs } from "./phase3.js";
import { addBuyerPrivacyRule, createBuyerSession, promptBuyerSetup, renewBuyer, setupBuyer } from "./buyer-setup.js";

const words = process.argv.slice(2);
let command = words.shift() ?? "";
if (["wallet", "offer", "pay", "resource", "memory", "audit", "capability", "settlement", "setup", "policy"].includes(command)) command += `.${words.shift() ?? ""}`;
const args = parseArgs(words);
try {
  const home = homePath(args);
  const result = command === "init" ? initialize(home, args) : command === "setup.buyer" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: typeof args.config === "string" ? setupBuyer(home, args.config) : await promptBuyerSetup(home) } : command === "setup.renew" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: renewBuyer(home, String(args.config ?? "")) } : command === "setup.session" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: createBuyerSession(home) } : command === "policy.add" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: await addBuyerPrivacyRule(home, String(args["capability-id"] ?? "")) } : await (async () => { const app = new Phase3App(home); try { return await app.execute(command, args); } finally { app.close(); } })();
  if (args.authorize === true) (result as typeof result & { warnings?: string[] }).warnings = ["--authorize is a deprecated compatibility path; SDK integrations must use bound approval tokens"];
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1;
}
