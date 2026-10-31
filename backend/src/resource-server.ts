#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Phase3App, errorOutput, homePath, parseArgs } from "./phase3.js";
import { X402ResourceService, type X402ResourceServiceConfig } from "./x402-resource-service.js";
import { fail } from "./errors.js";

const args = parseArgs(process.argv.slice(2)), required = (name: string): string => typeof args[name] === "string" ? args[name] : fail("ARGUMENT_REQUIRED", `--${name} is required`);
try {
  const app = new Phase3App(homePath(args)); if (app.profile.role !== "seller") fail("ROLE_FORBIDDEN", "resource service requires a seller role home");
  const document = JSON.parse(readFileSync(resolve(required("config")), "utf8")) as { service: X402ResourceServiceConfig; artifacts: Array<{ requestId: string; operationId: string; file: string }> };
  if (!Array.isArray(document.artifacts) || !document.artifacts.length) fail("RESOURCE_CONFIG_INVALID", "resource config needs at least one artifact");
  const service = new X402ResourceService(app.store, document.service), registered = document.artifacts.map((item) => ({ requestId: item.requestId, operationId: item.operationId, ...service.register(item.requestId, item.operationId, readFileSync(resolve(item.file))) })), server = service.createServer(), origin = new URL(document.service.origin), port = Number(origin.port || (origin.protocol === "https:" ? 443 : 80));
  server.listen(port, origin.hostname, () => process.stdout.write(`${JSON.stringify({ schemaVersion: "supercuts.resource.v1", ok: true, origin: document.service.origin, payTo: document.service.payTo, artifacts: registered })}\n`));
  const close = () => server.close(() => { app.close(); process.exit(0); }); process.on("SIGINT", close); process.on("SIGTERM", close);
} catch (error) { process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1; }
