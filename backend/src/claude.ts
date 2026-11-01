import { fail } from "./errors.js";

export interface ClaudeUsage { inputTokens: number; outputTokens: number; }
export interface ClaudeDecision<T extends Record<string, unknown>> { action: T; model: string; usage: ClaudeUsage; sanitizedRationale: string; }
export interface ClaudeActionSchema { name: string; description: string; properties: Record<string, Record<string, unknown>>; required: string[]; }
export interface BoundedClaudeOptions {
  apiKey?: string; model?: string; maxTurns?: number; maxTokens?: number; retries?: number;
  fetch?: typeof globalThis.fetch; onDecision?: (entry: { model: string; usage: ClaudeUsage; action: string; rationale: string }) => void;
}

const secret = /(?:suiprivkey|sk-ant-|-----BEGIN [A-Z ]*PRIVATE KEY-----|seed phrase|note opening|approval token)/gi;
export function sanitizeRationale(value: string): string { return value.replace(secret, "[REDACTED]").replace(/\s+/g, " ").trim().slice(0, 512); }

function validateAction(schema: ClaudeActionSchema, input: unknown): asserts input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("CLAUDE_OUTPUT_INVALID", "Claude tool input must be an object");
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!(key in schema.properties)) fail("CLAUDE_OUTPUT_INVALID", `Claude returned unknown field ${key}`);
  for (const key of schema.required) if (!(key in value)) fail("CLAUDE_OUTPUT_INVALID", `Claude omitted required field ${key}`);
  for (const [key, item] of Object.entries(value)) {
    const field = schema.properties[key]!;
    if (field.type === "string" && typeof item !== "string") fail("CLAUDE_OUTPUT_INVALID", `${key} must be a string`);
    if (field.type === "boolean" && typeof item !== "boolean") fail("CLAUDE_OUTPUT_INVALID", `${key} must be a boolean`);
    if (field.type === "array" && !Array.isArray(item)) fail("CLAUDE_OUTPUT_INVALID", `${key} must be an array`);
    if (Array.isArray(field.enum) && !field.enum.includes(item)) fail("CLAUDE_OUTPUT_INVALID", `${key} is not an allowed action value`);
    if (typeof item === "string" && typeof field.maxLength === "number" && item.length > field.maxLength) fail("CLAUDE_OUTPUT_INVALID", `${key} is too long`);
  }
}

/** Bounded reasoning only. Callers must supply policy-approved choices and own all amounts and success claims. */
export class BoundedClaude {
  readonly model: string;
  readonly #apiKey: string;
  readonly #maxTurns: number;
  readonly #maxTokens: number;
  readonly #retries: number;
  readonly #fetch: typeof globalThis.fetch;
  constructor(private readonly options: BoundedClaudeOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env.CLAUDE_API_KEY ?? "";
    if (!this.#apiKey) fail("CLAUDE_CREDENTIAL_MISSING", "CLAUDE_API_KEY is required for live agent reasoning");
    this.model = options.model ?? process.env.CLAUDE_MODEL ?? "claude-haiku-5-5";
    this.#maxTurns = options.maxTurns ?? 3; this.#maxTokens = options.maxTokens ?? 700; this.#retries = options.retries ?? 2; this.#fetch = options.fetch ?? fetch;
    if (!Number.isSafeInteger(this.#maxTurns) || this.#maxTurns < 1 || this.#maxTurns > 6 || !Number.isSafeInteger(this.#maxTokens) || this.#maxTokens < 32 || this.#maxTokens > 2048 || !Number.isSafeInteger(this.#retries) || this.#retries < 0 || this.#retries > 3) fail("CLAUDE_LIMIT_INVALID", "Claude bounds exceed the allowed demo limits");
  }

  async decide<T extends Record<string, unknown>>(input: { system: string; task: string; candidates: unknown[]; schema: ClaudeActionSchema }): Promise<ClaudeDecision<T>> {
    if (!input.task || input.task.length > 16_000 || input.system.length > 8_000 || input.candidates.length > 100) fail("CLAUDE_INPUT_INVALID", "Claude input exceeds bounded limits");
    const tool = { name: input.schema.name, description: input.schema.description, input_schema: { type: "object", properties: input.schema.properties, required: input.schema.required, additionalProperties: false } };
    let last: unknown;
    for (let turn = 0; turn < this.#maxTurns; turn++) {
      for (let attempt = 0; attempt <= this.#retries; attempt++) {
        let response: Response;
        try {
          response = await this.#fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": this.#apiKey }, body: JSON.stringify({ model: this.model, max_tokens: this.#maxTokens, system: input.system, messages: [{ role: "user", content: JSON.stringify({ task: input.task, policyApprovedCandidates: input.candidates }) }], tools: [tool], tool_choice: { type: "tool", name: input.schema.name } }), signal: AbortSignal.timeout(30_000) });
        } catch (error) { last = error; if (attempt < this.#retries) continue; return fail("CLAUDE_UNAVAILABLE", "Claude request failed closed", error); }
        if (!response.ok) { last = new Error(`Anthropic status ${response.status}`); if (attempt < this.#retries && (response.status === 429 || response.status >= 500)) { await response.arrayBuffer(); continue; } return fail("CLAUDE_UNAVAILABLE", `Claude returned status ${response.status}`); }
        let body: Record<string, any>; try { body = await response.json() as Record<string, any>; } catch (error) { return fail("CLAUDE_OUTPUT_INVALID", "Claude returned invalid JSON", error); }
        const blocks = Array.isArray(body.content) ? body.content : [], selected = blocks.find((block: any) => block?.type === "tool_use" && block.name === input.schema.name);
        if (!selected) { last = new Error("required tool call missing"); break; }
        validateAction(input.schema, selected.input);
        const rationaleBlock = blocks.find((block: any) => block?.type === "text" && typeof block.text === "string");
        const rationale = sanitizeRationale(String(selected.input.rationale ?? rationaleBlock?.text ?? "bounded selection"));
        const usage = { inputTokens: Number(body.usage?.input_tokens ?? 0), outputTokens: Number(body.usage?.output_tokens ?? 0) };
        const actionName = String(selected.input.action ?? selected.input.choice ?? input.schema.name);
        this.options.onDecision?.({ model: this.model, usage, action: actionName, rationale });
        return { action: selected.input as T, model: this.model, usage, sanitizedRationale: rationale };
      }
    }
    return fail("CLAUDE_OUTPUT_INVALID", "Claude did not produce a schema-valid bounded action", last);
  }
}
