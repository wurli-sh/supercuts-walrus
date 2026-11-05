#!/usr/bin/env node
import { Phase3App, errorOutput, homePath, initialize, parseArgs } from "./phase3.js";
import { addBuyerPrivacyRule, approveBuyerSeller, createBuyerSession, promptBuyerSetup, renewBuyer, setupBuyer } from "./buyer-setup.js";
import { onboardingDoctor } from "./onboarding-doctor.js";
import { executeFunding, prepareFunding } from "./funding.js";
import { packageHostedSeller } from "./seller-package.js";

const words = process.argv.slice(2);
let command = words.shift() ?? "";
if (["wallet", "offer", "pay", "resource", "memory", "audit", "capability", "settlement", "setup", "policy", "onboarding", "onboard", "funding", "seller"].includes(command)) command += `.${words.shift() ?? ""}`;
try {
  if (!command || command === "help" || command === "--help" || command === "setup.") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: "supercuts.help.v1", ok: true, commands: ["onboard buyer", "funding prepare", "funding execute", "seller package", "setup buyer", "setup renew", "setup session", "init", "doctor", "status", "wallet", "offer", "pay", "memory", "capability", "audit"], setup: "Run supercuts onboard buyer --home <private-directory> for guided live Testnet setup. Use seller package to validate and prepare an operator-assisted hosted seller bundle.", live: "Use funding prepare to calculate public gas/payment and shielded deposit requirements. Funding execute requires explicit confirmation and funds only the generated buyer address." })}\n`);
    process.exit(0);
  }
  const args = parseArgs(words);
  const home = homePath(args);
  const fundingInput = { publicPayment: String(args["public-payment"] ?? "0"), shieldedPayment: String(args["shielded-payment"] ?? "0"), ...(typeof args["gas-reserve"] === "string" ? { gasReserve: args["gas-reserve"] } : {}), ...(typeof args["change-reserve"] === "string" ? { changeReserve: args["change-reserve"] } : {}) };
  const result = command === "init" ? initialize(home, args) : command === "setup.buyer" || command === "onboard.buyer" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: typeof args.config === "string" ? setupBuyer(home, args.config) : await promptBuyerSetup(home) } : command === "setup.renew" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: renewBuyer(home, String(args.config ?? "")) } : command === "setup.session" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: createBuyerSession(home) } : command === "funding.prepare" ? { schemaVersion: "supercuts.funding.v1", ok: true, command, data: await prepareFunding(home, fundingInput) } : command === "funding.execute" ? { schemaVersion: "supercuts.funding.v1", ok: true, command, data: await executeFunding(home, { ...fundingInput, operationId: String(args["operation-id"] ?? ""), requestFaucet: args["request-faucet"] === true, confirmed: args.confirm === true }) } : command === "seller.package" ? { schemaVersion: "supercuts.seller-package.v1", ok: true, command, data: await packageHostedSeller({ home, spec: String(args.spec ?? ""), artifact: String(args.artifact ?? ""), metadata: String(args.metadata ?? ""), registration: String(args.registration ?? ""), bundle: String(args.bundle ?? ""), ...(typeof args["content-type"] === "string" ? { contentType: args["content-type"] } : {}) }) } : command === "policy.add" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: await addBuyerPrivacyRule(home, String(args["capability-id"] ?? "")) } : command === "policy.approve-seller" ? { schemaVersion: "supercuts.setup.v1", ok: true, command, data: await approveBuyerSeller(home, String(args["capability-id"] ?? "")) } : command === "onboarding.doctor" ? { schemaVersion: "supercuts.onboarding.v1", ok: true, command, data: await onboardingDoctor(home, typeof args.config === "string" ? args.config : undefined) } : await (async () => { const app = new Phase3App(home); try { return await app.execute(command, args); } finally { app.close(); } })();
  if (args.authorize === true) (result as typeof result & { warnings?: string[] }).warnings = ["--authorize is a deprecated compatibility path; SDK integrations must use bound approval tokens"];
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1;
}
