#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { verifySignedCapability, type SignedCapabilityRegistration } from "./capability.js";
import { fail } from "./errors.js";
import { errorOutput } from "./phase3.js";

async function main(): Promise<void> {
  const [command, file, directory] = process.argv.slice(2);
  if (command !== "publish" || !file || !directory) fail("ARGUMENT_REQUIRED", "usage: supercuts-seller-directory publish <owner-only-registration.json> <directory-origin>");
  const path = resolve(file!);
  if ((statSync(path).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "registration file must be owner-only");
  const registration = JSON.parse(readFileSync(path, "utf8")) as SignedCapabilityRegistration;
  await verifySignedCapability(registration);
  const url = new URL(directory!);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    fail("SELLER_DIRECTORY_INVALID", "directory origin must be HTTPS or loopback HTTP without path or credentials");
  const response = await fetch(new URL("/v2/directory/register", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registration }), redirect: "error", signal: AbortSignal.timeout(90_000) });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || result.ok !== true) fail("SELLER_DIRECTORY_UNAVAILABLE", String(result.message ?? `directory returned HTTP ${response.status}`));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
main().catch((error) => { process.stdout.write(`${JSON.stringify(errorOutput(error))}\n`); process.exitCode = 1; });
