#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { homePath } from "./phase3.js";

const home = homePath({});
if (existsSync(join(home, "profile.json"))) {
  await import("./mcp.js");
} else {
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let request: { id?: unknown; method?: string; params?: { name?: string } };
    try { request = JSON.parse(line) as typeof request; } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "supercuts-setup", version: "0.1.0" } } });
    if (request.method === "notifications/initialized") return;
    if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "setup.status", description: "Explain how the owner completes one-time buyer setup locally. Do not request secrets in chat.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
    if (request.method === "tools/call" && request.params?.name === "setup.status") {
      const result = { schemaVersion: "supercuts.setup.v1", ok: true, configured: false, home, nextStep: `Run supercuts setup buyer --home ${JSON.stringify(home)} in a terminal, then restart this MCP connection. The command asks for policy limits, seller origins and local credential file paths. Do not paste keys or tokens into Codex.` };
      return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
    }
    return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  });
}
