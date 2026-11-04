#!/usr/bin/env node
import { Phase3App, errorOutput, homePath, initialize, parseArgs } from "./phase3.js";
import { addBuyerPrivacyRule, approveBuyerSeller, createBuyerSession, promptBuyerSetup, renewBuyer, setupBuyer } from "./buyer-setup.js";
import { onboardingDoctor } from "./onboarding-doctor.js";

const words = process.argv.slice(2);
let command = words.shift() ?? "";
if (["wallet", "offer", "pay", "resource", "memory", "audit", "capability", "settlement", "setup", "policy", "onboarding"].includes(command)) command += `.${words.shift() ?? ""}`;
try {
  if (!command || command === "help" || command === "--help" || command === "setup.") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: "supercuts.help.v1", ok: true, commands: ["setup buyer", "setup renew", "setup session", "init", "doctor", "status", "wallet", "offer", "pay", "memory", "capability", "audit"], setup: "Run supercuts setup buyer --home <private-directory> for guided live Testnet setup. Run supercuts init --role <buyer|seller|auditor> --mock --home <private-directory> for a local non-funded profile. Keep each role in a separate owner-only home.", live: "Supply the pinned Testnet deployment config, owner-only credential files, Sui and Tatum RPC endpoints, Walrus endpoints, local proving artifacts, and RapidSnark. Fund only the buyer address printed by supercuts-demo setup." })}\n`);
    process.exit(0);
  }
  const args = parseArgs(words);
  const home = homePath(args);
  const result = command === "init" ? initialize(home, args) : command === "setup.buyer" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: typeof args.config === "string" ? setupBuyer(home, args.config) : await promptBuyerSetup(home) } : command === "setup.renew" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: renewBuyer(home, String(args.config ?? "")) } : command === "setup.session" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: createBuyerSession(home) } : command === "policy.add" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: await addBuyerPrivacyRule(home, String(args["capability-id"] ?? "")) } : command === "policy.approve-seller" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: await approveBuyerSeller(home, String(args["capability-id"] ?? "")) } : command === "onboarding.doctor" ? { schemaVersion: "supercuts.onboarding.v1", ok: true, command, data: await onboardingDoctor(home, typeof args.config === "string" ? args.config : undefined) } : await (async () => { const app = new Phase3App(home); try { return await app.execute(command, args); } finally { app.close(); } })();
  if (args.authorize === true) (result as typeof result & { warnings?: string[] }).warnings = ["--authorize is a deprecated compatibility path; SDK integrations must use bound approval tokens"];
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1;
}
