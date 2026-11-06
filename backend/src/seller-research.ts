import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "./errors.js";

export type SellerResearchKind = "market-brief" | "competitor-analysis";

export interface SellerResearchDraft {
  title: string;
  body: string;
  citations: string[];
  preview: { summary: string; relevance: number; sourceQuality: number; freshnessDays: number };
  reviewStatus: "draft-needs-owner-review";
  research: { model: string; generatedAt: string; sourceCount: number; topic: string; kind: SellerResearchKind };
}

export interface SellerResearchOptions {
  apiKey?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  maxSearches?: number;
  maxTokens?: number;
  allowedDomains?: string[];
  now?: Date;
}

const asObject = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : fail("SELLER_RESEARCH_INVALID", "Claude research output must be an object");
const submittedTool = (blocks: any[]): any | undefined => {
  for (const block of blocks) if (block?.type === "tool_use" && block.name === "submit_research") {
    if (block.input && typeof block.input === "object" && !Array.isArray(block.input)) return block;
    if (typeof block.input === "string") try { const input = JSON.parse(block.input); if (input && typeof input === "object" && !Array.isArray(input)) return { ...block, input }; } catch {}
  }
  return undefined;
};
const normalizedUrl = (value: string): string => { const url = new URL(value); url.hash = ""; if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, ""); return url.toString(); };

function sourceUrls(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) sourceUrls(item, found);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "url" && typeof item === "string") { try { if (new URL(item).protocol === "https:") found.add(normalizedUrl(item)); } catch {} }
    sourceUrls(item, found);
  }
  return found;
}

function validateDraft(value: unknown, evidence: Set<string>, allowedDomains: readonly string[]): Omit<SellerResearchDraft, "reviewStatus" | "research"> {
  const draft = asObject(value), preview = asObject(draft.preview);
  if (typeof draft.title !== "string" || draft.title.trim().length < 8 || draft.title.length > 180) fail("SELLER_RESEARCH_INVALID", "research title must contain 8 to 180 characters");
  if (typeof draft.body !== "string" || draft.body.trim().length < 800 || draft.body.length > 16_000) fail("SELLER_RESEARCH_INVALID", "research body must contain 800 to 16,000 characters");
  if (!Array.isArray(draft.citations)) fail("SELLER_RESEARCH_INVALID", "research citations must be an array");
  if (draft.citations.length < 3 || draft.citations.length > 32) fail("SELLER_RESEARCH_INVALID", `research must contain 3 to 32 citations; received ${draft.citations.length}`);
  let citations = draft.citations.map((item: unknown) => {
    if (typeof item !== "string") return fail("SELLER_RESEARCH_INVALID", "every citation must be an HTTPS URL");
    let url: URL; try { url = new URL(item); } catch (error) { return fail("SELLER_RESEARCH_INVALID", "every citation must be a valid URL", error); }
    if (url.protocol !== "https:" || url.username || url.password) fail("SELLER_RESEARCH_INVALID", "every citation must be a public HTTPS URL without credentials");
    if (allowedDomains.length && !allowedDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) fail("SELLER_RESEARCH_SOURCE_UNAPPROVED", `citation host ${url.hostname} is outside --allowed-domains`);
    const normalized = normalizedUrl(item);
    if (!evidence.has(normalized)) fail("SELLER_RESEARCH_SOURCE_UNVERIFIED", "Claude cited a URL that was not returned by web search");
    return normalized;
  });
  if (new Set(citations).size !== citations.length) fail("SELLER_RESEARCH_INVALID", "research citations must be unique");
  let reportBody = draft.body.trim();
  const markers = [...reportBody.matchAll(/\[([1-9][0-9]*)\]/g)].map((match: RegExpMatchArray) => Number(match[1]));
  if (markers.some((index: number) => index > citations.length)) fail("SELLER_RESEARCH_INVALID", "research body contains an out-of-range citation marker");
  const used = [...new Set(markers)].sort((a, b) => a - b);
  if (used.length < 3) fail("SELLER_RESEARCH_INVALID", "research body must reference at least three listed sources inline");
  if (used.length !== citations.length) {
    const remap = new Map(used.map((oldIndex, newIndex) => [oldIndex, newIndex + 1]));
    reportBody = reportBody.replace(/\[([1-9][0-9]*)\]/g, (_marker: string, raw: string) => `[${remap.get(Number(raw))}]`);
    citations = used.map((index) => citations[index - 1]!);
  }
  if (typeof preview.summary !== "string" || preview.summary.trim().length < 30 || preview.summary.length > 400) fail("SELLER_RESEARCH_INVALID", "preview summary must contain 30 to 400 characters");
  for (const key of ["relevance", "sourceQuality"] as const) if (typeof preview[key] !== "number" || !Number.isFinite(preview[key]) || preview[key] < 0 || preview[key] > 1) fail("SELLER_RESEARCH_INVALID", `preview ${key} must be in [0,1]`);
  if (!Number.isInteger(preview.freshnessDays) || preview.freshnessDays < 0 || preview.freshnessDays > 365) fail("SELLER_RESEARCH_INVALID", "preview freshnessDays must be an integer in [0,365]");
  return { title: draft.title.trim(), body: reportBody, citations, preview: { summary: preview.summary.trim(), relevance: preview.relevance, sourceQuality: preview.sourceQuality, freshnessDays: preview.freshnessDays } };
}

/** Generates an owner-review draft. It never publishes or mutates a live seller. */
export class ClaudeSellerResearcher {
  readonly model: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxSearches: number;
  readonly #maxTokens: number;
  readonly #allowedDomains: string[];
  readonly #now: Date;

  constructor(options: SellerResearchOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env.CLAUDE_API_KEY ?? "";
    if (!this.#apiKey) fail("CLAUDE_CREDENTIAL_MISSING", "CLAUDE_API_KEY is required to generate a seller research draft");
    this.model = options.model ?? process.env.CLAUDE_RESEARCH_MODEL ?? process.env.CLAUDE_MODEL ?? "claude-haiku-5-5";
    this.#fetch = options.fetch ?? fetch;
    this.#maxSearches = options.maxSearches ?? 8;
    this.#maxTokens = options.maxTokens ?? 5_000;
    this.#allowedDomains = (options.allowedDomains ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean);
    this.#now = options.now ?? new Date();
    if (!Number.isInteger(this.#maxSearches) || this.#maxSearches < 3 || this.#maxSearches > 12 || !Number.isInteger(this.#maxTokens) || this.#maxTokens < 1_500 || this.#maxTokens > 8_192) fail("CLAUDE_LIMIT_INVALID", "seller research bounds are invalid");
    if (this.#allowedDomains.some((item) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(item))) fail("SELLER_RESEARCH_INVALID", "allowed domains must be bare DNS names");
  }

  async research(input: { kind: SellerResearchKind; topic: string; context?: Record<string, unknown> }): Promise<SellerResearchDraft> {
    if (!(["market-brief", "competitor-analysis"] as string[]).includes(input.kind) || !input.topic.trim() || input.topic.length > 500) fail("SELLER_RESEARCH_INVALID", "research needs a valid kind and a topic of at most 500 characters");
    const context = input.context ? JSON.stringify(input.context) : "none";
    if (context.length > 40_000) fail("SELLER_RESEARCH_INVALID", "matching brief context is too large");
    const schema = {
      type: "object", additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: 180 }, body: { type: "string", maxLength: 16000 }, citations: { type: "array", minItems: 3, maxItems: 32, items: { type: "string" } },
        preview: { type: "object", additionalProperties: false, properties: { summary: { type: "string", maxLength: 400 }, relevance: { type: "number", minimum: 0, maximum: 1 }, sourceQuality: { type: "number", minimum: 0, maximum: 1 }, freshnessDays: { type: "integer", minimum: 0, maximum: 365 } }, required: ["summary", "relevance", "sourceQuality", "freshnessDays"] },
      }, required: ["title", "body", "citations", "preview"],
    };
    const webSearch: Record<string, unknown> = { type: "web_search_20250305", name: "web_search", max_uses: this.#maxSearches, allowed_callers: ["direct"] };
    if (this.#allowedDomains.length) webSearch.allowed_domains = this.#allowedDomains;
    const system = `<role>You are the research desk for a paid Sui ecosystem intelligence seller.</role>
<quality_bar>Use web search before writing. Prefer primary sources, official documentation, project announcements, repositories, and dated first-party metrics. Cross-check material claims across independent sources. Separate observed facts from analysis, name dates and measurement windows, surface uncertainty and counter-evidence, and never invent a fact, quotation, number, or URL. The report must be useful to a technically sophisticated buyer, not promotional copy.</quality_bar>
<format>After research and a final self-check, call submit_research exactly once. Write a cohesive 800-16000 character report. Include inline source markers such as [1] that correspond in order to the citations array. Use only HTTPS URLs actually returned by web_search. Provide at least 3 unique sources and include additional material sources when useful. Preview scores are seller estimates, not independent guarantees.</format>`;
    const prompt = `<today>${this.#now.toISOString().slice(0, 10)}</today><kind>${input.kind}</kind><topic>${input.topic.trim()}</topic><matching_brief_context>${context}</matching_brief_context><instructions>Research the topic broadly enough to identify market structure, concrete evidence, important competitors or alternatives, risks, and what would change the conclusion. For competitor analysis, directly compare the purchased brief's thesis with named competing projects or approaches. Before submission, verify every citation was observed in search results and every quantitative claim is qualified by date and source.</instructions>`;
    const request = async (payload: Record<string, unknown>): Promise<Record<string, any>> => {
      let response: Response;
      try {
        response = await this.#fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": this.#apiKey }, body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000) });
      } catch (error) { return fail("CLAUDE_UNAVAILABLE", "Claude research request failed closed", error); }
      if (!response.ok) { await response.arrayBuffer(); return fail("CLAUDE_UNAVAILABLE", `Claude research returned status ${response.status}`); }
      try { return await response.json() as Record<string, any>; } catch (error) { return fail("CLAUDE_OUTPUT_INVALID", "Claude research returned invalid JSON", error); }
    };
    const submitTool = { name: "submit_research", description: "Submit the source-checked seller research draft for owner review.", input_schema: schema };
    let messages: Array<Record<string, unknown>> = [{ role: "user", content: prompt }], selected: any;
    const blocks: any[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const body = await request({ model: this.model, max_tokens: this.#maxTokens, system, messages, tools: [webSearch, submitTool] });
      const current = Array.isArray(body.content) ? body.content : [];
      blocks.push(...current);
      selected = submittedTool(current);
      if (selected || current.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim())) break;
      if (!current.length || turn === 2) break;
      // Anthropic can pause a server-side search turn. Replay its opaque content
      // unchanged so the model can synthesize the already-returned evidence.
      messages = [...messages, { role: "assistant", content: current }, { role: "user", content: "Continue the paused research turn using the returned search evidence, then submit the structured draft." }];
    }
    const searchFailure = blocks.some((block: any) => block?.type === "web_search_tool_result" && (block.is_error === true || block.content?.type === "web_search_tool_result_error"));
    if (searchFailure) fail("SELLER_RESEARCH_SEARCH_FAILED", "Claude web search failed; no draft was written");
    const evidence = sourceUrls(blocks);
    if (evidence.size < 3) fail("SELLER_RESEARCH_SOURCE_UNVERIFIED", "Claude returned fewer than three verifiable web-search sources");
    if (selected) try {
      const draft = validateDraft(selected.input, evidence, this.#allowedDomains);
      return { ...draft, reviewStatus: "draft-needs-owner-review", research: { model: this.model, generatedAt: this.#now.toISOString(), sourceCount: evidence.size, topic: input.topic.trim(), kind: input.kind } };
    } catch {}
    const researchedText = blocks.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n").slice(0, 30_000) || (selected ? JSON.stringify(selected.input).slice(0, 30_000) : "");
    if (!researchedText) fail("CLAUDE_OUTPUT_INVALID", "Claude returned search evidence without a research answer");
    const editorSystem = `<role>You are a strict research editor.</role><instructions>Convert or repair the supplied web-researched answer into the submit_research schema. Preserve material uncertainty, dates, comparisons, and counter-evidence. Use only URLs in verified_sources, include at least 3 unique citations and all additional material sources, and do not add facts or sources. The body must be 800-16000 characters and use [1], [2], and subsequent inline markers corresponding to citation order. Ensure preview is an object with summary, relevance, sourceQuality, and integer freshnessDays. Call submit_research exactly once.</instructions>`;
    const edited = await request({ model: this.model, max_tokens: this.#maxTokens, system: editorSystem, messages: [{ role: "user", content: JSON.stringify({ kind: input.kind, topic: input.topic.trim(), researchedAnswer: researchedText, verifiedSources: [...evidence].slice(0, 32) }) }], tools: [submitTool], tool_choice: { type: "tool", name: "submit_research" } });
    const editedBlocks = Array.isArray(edited.content) ? edited.content : [];
    selected = submittedTool(editedBlocks);
    if (!selected) fail("CLAUDE_OUTPUT_INVALID", "Claude did not submit a structured research draft");
    const draft = validateDraft(selected.input, evidence, this.#allowedDomains);
    return { ...draft, reviewStatus: "draft-needs-owner-review", research: { model: this.model, generatedAt: this.#now.toISOString(), sourceCount: evidence.size, topic: input.topic.trim(), kind: input.kind } };
  }
}

export async function generateSellerResearch(input: { kind: string; topic: string; output: string; contextFile?: string; allowedDomains?: string; apiKey?: string; model?: string; fetch?: typeof globalThis.fetch }): Promise<Record<string, unknown>> {
  const kind = input.kind as SellerResearchKind;
  const output = resolve(input.output || fail("ARGUMENT_REQUIRED", "seller research requires --output"));
  let context: Record<string, unknown> | undefined;
  if (input.contextFile) {
    const path = resolve(input.contextFile);
    if ((statSync(path).mode & 0o077) !== 0) fail("SELLER_CONFIG_PERMISSIONS", "research context file must be owner-only");
    context = asObject(JSON.parse(readFileSync(path, "utf8")));
  }
  const allowedDomains = input.allowedDomains?.split(",").map((item) => item.trim()).filter(Boolean);
  const researcher = new ClaudeSellerResearcher({ ...(input.apiKey ? { apiKey: input.apiKey } : {}), ...(input.model ? { model: input.model } : {}), ...(input.fetch ? { fetch: input.fetch } : {}), ...(allowedDomains?.length ? { allowedDomains } : {}) });
  const draft = await researcher.research({ kind, topic: input.topic, ...(context ? { context } : {}) });
  writeFileSync(output, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { output, kind, topic: input.topic, model: researcher.model, citations: draft.citations.length, reviewStatus: draft.reviewStatus, nextStep: "Review every claim and citation, then set reviewStatus to approved before catalog generation or seller packaging." };
}
