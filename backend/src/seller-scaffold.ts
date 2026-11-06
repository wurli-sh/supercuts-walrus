import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "./errors.js";

const idPattern = /^[a-z0-9][a-z0-9._-]{1,127}$/;

export function scaffoldSeller(input: Record<string, string | boolean>): Record<string, unknown> {
  const home = typeof input.home === "string" ? resolve(input.home) : fail("ARGUMENT_REQUIRED", "seller scaffold requires --home");
  const output = typeof input.output === "string" ? resolve(input.output) : fail("ARGUMENT_REQUIRED", "seller scaffold requires --output");
  const capabilityId = String(input["capability-id"] ?? ""), capability = String(input.capability ?? ""), description = String(input.description ?? ""), origin = String(input.origin ?? ""), price = String(input.price ?? "");
  if (!idPattern.test(capabilityId) || !idPattern.test(capability)) fail("SELLER_SCAFFOLD_INVALID", "capability identifiers must use 2..128 lowercase letters, digits, dot, underscore, or dash");
  if (!description || description.length > 512 || !/^[1-9][0-9]*$/.test(price)) fail("SELLER_SCAFFOLD_INVALID", "description and positive MIST --price are required");
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("SELLER_SCAFFOLD_INVALID", "origin must be an HTTPS or loopback HTTP origin without path or credentials");
  const rails = String(input.rails ?? "x402").split(",").map((rail) => rail.trim()).filter(Boolean);
  if (!rails.length || rails.some((rail) => rail !== "x402" && rail !== "shielded") || new Set(rails).size !== rails.length) fail("SELLER_SCAFFOLD_INVALID", "--rails must be x402, shielded, or x402,shielded");
  const days = Number(input["expires-in-days"] ?? "30");
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) fail("SELLER_SCAFFOLD_INVALID", "--expires-in-days must be 1..365");
  const listenPort = Number(input["listen-port"] ?? (url.protocol === "http:" && url.port ? url.port : "8788"));
  if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535) fail("SELLER_SCAFFOLD_INVALID", "--listen-port must be 1..65535");
  mkdirSync(output, { recursive: false, mode: 0o700 }); chmodSync(output, 0o700);
  const specPath = resolve(output, "capability.json"), handlerPath = resolve(output, "handler.mjs"), registrationPath = resolve(output, "registration.json"), servicePath = resolve(output, "seller-service.json");
  const spec = { capabilityId, capability, description, inputSchema: { type: "object", required: ["task"], properties: { task: { type: "string", minLength: 1, maxLength: 4096 } }, additionalProperties: false }, outputSchema: { type: "object", required: ["kind"], properties: { kind: { const: capability } }, additionalProperties: false }, supportedRails: rails, priceBand: { minimum: price, maximum: price }, asset: "0x2::sui::SUI", endpoint: `${url.origin}/v2/resource/${capabilityId}`, expiresAt: Date.now() + days * 86_400_000 };
  const handler = `export async function handle(request) {\n  const result = { kind: ${JSON.stringify(capability)}, task: request.input.task, message: "Replace this template with your seller implementation." };\n  return { artifact: Buffer.from(JSON.stringify(result)), contentType: "application/json", metadata: { kind: ${JSON.stringify(capability)} } };\n}\n`;
  const service = { origin: url.origin, listenHost: "127.0.0.1", listenPort, ...(rails.includes("x402") ? { facilitatorUrlEnv: "X402_FACILITATOR_URL", facilitatorKeyEnv: "FACILITATOR_SHARED_KEY" } : {}), capabilities: [{ registrationFile: registrationPath, handler: handlerPath }] };
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  writeFileSync(handlerPath, handler, { mode: 0o600, flag: "wx" });
  writeFileSync(servicePath, `${JSON.stringify(service, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { home, output, specFile: specPath, handlerFile: handlerPath, registrationFile: registrationPath, serviceFile: servicePath, expiresAt: spec.expiresAt, nextCommands: [`supercuts-seller-register ${JSON.stringify(home)} ${JSON.stringify(specPath)} ${JSON.stringify(registrationPath)}`, `supercuts-seller-live ${JSON.stringify(home)} ${JSON.stringify(servicePath)}`], note: "Review and replace the generated handler before serving production work." };
}
