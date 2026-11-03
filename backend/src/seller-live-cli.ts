#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fail } from "./errors.js";
import { Phase3App, errorOutput } from "./phase3.js";
import { LiveSellerTransport } from "./live-seller-transport.js";
import type { SignedCapabilityRegistration } from "./capability.js";
import type { ServiceHandler } from "./seller-runtime.js";

interface Config { origin: string; listenHost?: string; listenPort?: number; facilitatorUrl?: string; facilitatorKey?: string; allowedBuyers?: string[]; capabilities: Array<{ registration?: SignedCapabilityRegistration; registrationFile?: string; handler: string }> }
async function main(): Promise<void> {
  const home = process.argv[2], configPath = process.argv[3];
  if (!home || !configPath) return fail("ARGUMENT_REQUIRED", "usage: supercuts-seller-live <seller-home> <owner-only-config.json>");
  if ((statSync(configPath).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "seller config must be owner-only");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  if (!Array.isArray(config.capabilities) || !config.capabilities.length) fail("SELLER_CONFIG_INVALID", "seller config must name registered capabilities and handlers");
  const app = new Phase3App(home), transport = new LiveSellerTransport(app, config);
  try {
    for (const item of config.capabilities) {
      let registration = item.registration;
      if (item.registrationFile) {
        const registrationPath = resolve(item.registrationFile);
        if ((statSync(registrationPath).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "registration file must be owner-only");
        registration = JSON.parse(readFileSync(registrationPath, "utf8")) as SignedCapabilityRegistration;
      }
      if (!registration) return fail("SELLER_CONFIG_INVALID", "capability requires registration or registrationFile");
      const path = resolve(item.handler);
      if ((statSync(path).mode & 0o077) !== 0) fail("SELLER_HANDLER_PERMISSIONS", "seller handler module must be owner-only");
      const loaded = await import(pathToFileURL(path).href) as { default?: ServiceHandler; handle?: ServiceHandler };
      const handler = loaded.default ?? loaded.handle;
      if (typeof handler !== "function") return fail("SELLER_HANDLER_INVALID", "seller handler must export default or handle(request)");
      await transport.register(registration, handler);
    }
    const origin = new URL(config.origin), server = transport.createServer();
    const host = config.listenHost ?? "127.0.0.1", port = config.listenPort ?? (origin.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(origin.hostname) ? Number(origin.port || 80) : 8788);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("SELLER_CONFIG_INVALID", "seller listenPort must be a valid TCP port");
    await new Promise<void>((done) => server.listen(port, host, done));
    process.stdout.write(`${JSON.stringify({ ok: true, service: "supercuts-seller-live", origin: config.origin, capabilities: transport.runtime.catalog().map((item) => item.manifest.capabilityId) })}\n`);
    const stop = () => server.close(() => { app.close(); process.exit(0); });
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  } catch (error) { app.close(); throw error; }
}
main().catch((error) => { process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1; });
