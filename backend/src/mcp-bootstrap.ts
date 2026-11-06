#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { homePath } from "./phase3.js";

const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const home = homePath({});
if (existsSync(join(home, "profile.json"))) {
  await import("./mcp.js");
} else {
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const rl = createInterface({ input: process.stdin });
  let promoting = false;
  const promote = (): void => {
    if (promoting) return; promoting = true;
    setImmediate(() => { rl.close(); void import("./mcp.js"); });
  };
  rl.on("line", (line) => {
    if (Buffer.byteLength(line) > 1024 * 1024) return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request exceeds 1 MiB" } });
    let request: { id?: unknown; method?: string; params?: { name?: string } };
    try { request = JSON.parse(line) as typeof request; } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    if (!request || typeof request !== "object" || typeof request.method !== "string" || request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } });
    if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "supercuts-setup", version: PACKAGE_VERSION } } });
    if (request.method === "notifications/initialized") return;
    if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools: [
      { name: "setup.status", description: "Explain how the owner completes one-time buyer or seller setup locally. Do not request secrets in chat.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "setup.refresh", description: "Reload this MCP connection after the owner completes local setup.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    ] } });
    if (request.method === "tools/call" && request.params?.name === "setup.status") {
      const configured = existsSync(join(home, "profile.json"));
      const result = { schemaVersion: "supercuts.setup.v1", ok: true, configured, home, nextStep: configured ? "Call setup.refresh to load the configured role tools without restarting the connector." : `Run supercuts onboard buyer --home ${JSON.stringify(home)} or supercuts onboard seller --home ${JSON.stringify(home)} in a terminal, then call setup.refresh. Use a separate owner-only home for every role and identity. Do not paste keys or tokens into Codex.` };
      return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
    }
    if (request.method === "tools/call" && request.params?.name === "setup.refresh") {
      if (!existsSync(join(home, "profile.json"))) {
        const result = { schemaVersion: "supercuts.setup.v1", ok: false, error: { code: "SETUP_REQUIRED", message: "role setup is not complete", recovery: `Run supercuts onboard buyer --home ${JSON.stringify(home)} or supercuts onboard seller --home ${JSON.stringify(home)} locally, then retry setup.refresh.` } };
        return send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      }
      const result = { schemaVersion: "supercuts.setup.v1", ok: true, configured: true, reloading: true };
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      promote(); return;
    }
    return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  });
}
