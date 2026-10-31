import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fail } from "./errors.js";

export type DemoActor = "operator" | "buyer" | "public-seller" | "confidential-seller" | "auditor" | "supercuts";
export type DemoStatus = "started" | "pending" | "allowed" | "rejected" | "complete" | "failed" | "recorded";
export interface DemoEvent {
  schema: "supercuts.demo.v1";
  sequence: number;
  runId: string;
  timestamp: string;
  actor: DemoActor;
  stage: string;
  status: DemoStatus;
  mode: "live" | "recorded-funded-run";
  publicDetails: Record<string, unknown>;
  evidenceHashes: string[];
  explorerLinks: string[];
}

const secretKey = /(?:secret|private.?key|seed|witness|opening|approval.?token|signature|ciphertext|prompt|authorization)/i;
const secretText = /(?:suiprivkey|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:mnemonic|seed phrase|approval token)\s*[:=])/i;

export function redactPublicDetails(value: unknown, key = "root"): unknown {
  if (secretKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return secretText.test(value) ? "[REDACTED]" : value;
  if (Array.isArray(value)) return value.map((item) => redactPublicDetails(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redactPublicDetails(item, name)]));
  return value;
}

export function evidenceHash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

export class DemoEventLog {
  readonly runId: string;
  #sequence = 0;
  constructor(readonly path: string, runId: string = randomUUID(), readonly mode: DemoEvent["mode"] = "live") {
    this.runId = runId;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      if ((statSync(path).mode & 0o077) !== 0) fail("EVENT_PERMISSIONS", "demo event stream must be owner-only");
      const events = readDemoEvents(path); this.#sequence = events.at(-1)?.sequence ?? 0;
      if (events.some((event) => event.runId !== runId)) fail("EVENT_RUN_CONFLICT", "event file already belongs to another run");
    } else writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  append(input: Omit<DemoEvent, "schema" | "sequence" | "runId" | "timestamp" | "mode">): DemoEvent {
    const event: DemoEvent = {
      schema: "supercuts.demo.v1", sequence: ++this.#sequence, runId: this.runId, timestamp: new Date().toISOString(), mode: this.mode,
      ...input, publicDetails: redactPublicDetails(input.publicDetails) as Record<string, unknown>,
    };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return event;
  }
}

export function readDemoEvents(path: string): DemoEvent[] {
  if (!existsSync(path)) fail("EVENT_STREAM_NOT_FOUND", `event stream ${path} does not exist`);
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => {
    let event: DemoEvent; try { event = JSON.parse(line) as DemoEvent; } catch (error) { return fail("EVENT_STREAM_INVALID", `event line ${index + 1} is invalid JSON`, error); }
    if (event.schema !== "supercuts.demo.v1" || event.sequence !== index + 1 || !event.runId || !event.actor || !event.stage || !event.status || !event.publicDetails || !Array.isArray(event.evidenceHashes) || !Array.isArray(event.explorerLinks)) fail("EVENT_STREAM_INVALID", `event line ${index + 1} has an invalid shape or sequence`);
    return event;
  });
}

export function recordedReplay(events: DemoEvent[]): DemoEvent[] {
  return events.map((event) => ({ ...event, mode: "recorded-funded-run", status: event.status === "started" || event.status === "pending" ? "recorded" : event.status }));
}
