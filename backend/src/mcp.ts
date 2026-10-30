#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Phase3App, errorOutput, homePath } from "./phase3.js";

const home = homePath({});
const app = new Phase3App(home);
const tools: Record<string, string> = {
  buyer: "status,doctor,capability.discover,wallet.deposit,wallet.balance,wallet.recover,wallet.withdraw,offer.open,offer.propose,offer.accept,offer.show,pay.quote,pay.shielded,pay.x402,pay.status,resource.fetch,memory.remember,memory.recall,memory.status,disclose",
  seller: "status,doctor,capability.publish,wallet.balance,wallet.recover,wallet.withdraw,offer.counter,offer.show,pay.status,resource.serve,resource.fetch,memory.remember,memory.recall,memory.status",
  auditor: "status,doctor,audit.verify",
};
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const rl = createInterface({ input: process.stdin });
let queue: Promise<unknown> = Promise.resolve();
rl.on("line", (line) => { queue = queue.then(async () => {
  let request: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { request = JSON.parse(line) as typeof request; } catch { return send({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
  try {
    if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `supercuts-${app.profile.role}`, version: "0.1.0" } } });
    if (request.method === "notifications/initialized") return;
    if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools: tools[app.profile.role]!.split(",").map((name) => ({ name, description: `${app.profile.role} ${name}`, inputSchema: { type: "object", additionalProperties: true } })) } });
    if (request.method === "tools/call") {
      const name = String(request.params?.name ?? ""), raw = (request.params?.arguments ?? {}) as Record<string, unknown>, args: Record<string, string | boolean> = {};
      for (const [key, value] of Object.entries(raw)) args[key] = typeof value === "boolean" ? value : String(value);
      const result = await app.execute(name, args); return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
    }
    return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  } catch (error) { return send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(errorOutput(error)) }], structuredContent: errorOutput(error) } }); }
  }).catch((error) => send({ jsonrpc: "2.0", error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" }, id: null })); });
const close = () => { app.close(); process.exit(0); };
process.on("SIGINT", close); process.on("SIGTERM", close);
