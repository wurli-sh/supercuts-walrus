#!/usr/bin/env node
import { Phase3App, errorOutput, homePath, initialize, parseArgs } from "./phase3.js";

const words = process.argv.slice(2);
let command = words.shift() ?? "";
if (["wallet", "offer", "pay", "resource", "memory", "audit", "capability"].includes(command)) command += `.${words.shift() ?? ""}`;
const args = parseArgs(words);
try {
  const home = homePath(args);
  const result = command === "init" ? initialize(home, args) : await (async () => { const app = new Phase3App(home); try { return await app.execute(command, args); } finally { app.close(); } })();
  if (args.authorize === true) (result as typeof result & { warnings?: string[] }).warnings = ["--authorize is a deprecated compatibility path; SDK integrations must use bound approval tokens"];
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1;
}
