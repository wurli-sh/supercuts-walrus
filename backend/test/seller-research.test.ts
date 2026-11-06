import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeSellerResearcher, generateSellerResearch } from "../src/seller-research.js";

const urls = ["https://docs.sui.io/concepts", "https://sui.io/research", "https://github.com/MystenLabs/sui"];
const draft = {
  title: "Sui ecosystem market structure and execution risks",
  body: `${"Evidence-backed market analysis with dated observations and explicit uncertainty. ".repeat(14)} [1] [2] [3]`,
  citations: urls,
  preview: { summary: "A source-checked view of Sui market structure, competitors, and execution risks.", relevance: 0.91, sourceQuality: 0.88, freshnessDays: 2 },
};
const response = (input: unknown = draft) => new Response(JSON.stringify({
  content: [
    { type: "server_tool_use", name: "web_search", input: { query: "Sui market" } },
    { type: "web_search_tool_result", content: urls.map((url) => ({ type: "web_search_result", url, title: url })) },
    { type: "tool_use", name: "submit_research", input },
  ], usage: { input_tokens: 100, output_tokens: 500 },
}), { status: 200, headers: { "content-type": "application/json" } });

test("seller research uses web search and writes an owner-review-only draft", async () => {
  const calls: Record<string, any>[] = [], root = mkdtempSync(join(tmpdir(), "seller-research-")), output = join(root, "brief.json");
  const result = await generateSellerResearch({ kind: "market-brief", topic: "Sui ecosystem risk", output, apiKey: "test", fetch: async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return response(); } });
  assert.equal(result.reviewStatus, "draft-needs-owner-review");
  assert.equal(statSync(output).mode & 0o077, 0);
  const stored = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(stored.reviewStatus, "draft-needs-owner-review");
  assert.equal(stored.citations.length, 3);
  assert.equal(stored.research.model, "claude-haiku-5-5");
  assert.equal(calls[0]!.tools[0].type, "web_search_20250305");
  assert.equal(calls[0]!.tools[0].max_uses, 8);
  assert.deepEqual(calls[0]!.tools[0].allowed_callers, ["direct"]);
  assert.match(calls[0]!.system, /Cross-check material claims/);
});

test("seller research rejects citations not observed in web-search evidence", async () => {
  const researcher = new ClaudeSellerResearcher({ apiKey: "test", fetch: async () => response({ ...draft, citations: [urls[0], urls[1], "https://fabricated.example/claim"] }) });
  await assert.rejects(() => researcher.research({ kind: "market-brief", topic: "Sui" }), { code: "SELLER_RESEARCH_SOURCE_UNVERIFIED" });
});

test("seller research converts a searched text answer in one bounded editor pass", async () => {
  const calls: Record<string, any>[] = [];
  const researcher = new ClaudeSellerResearcher({ apiKey: "test", fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request);
    if (calls.length === 1) return new Response(JSON.stringify({ content: [{ type: "web_search_tool_result", content: urls.map((url) => ({ type: "web_search_result", url })) }, { type: "text", text: "A searched report with source-backed observations. [1] [2] [3]" }] }), { status: 200 });
    return response();
  } });
  const result = await researcher.research({ kind: "market-brief", topic: "Sui" });
  assert.equal(result.citations.length, 3);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.tool_choice, { type: "tool", name: "submit_research" });
  assert.equal(calls[1]!.tools.some((tool: any) => tool.name === "web_search"), false);
});

test("seller research resumes a paused server-side search before editing", async () => {
  const calls: Record<string, any>[] = [];
  const researcher = new ClaudeSellerResearcher({ apiKey: "test", fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request);
    if (calls.length === 1) return new Response(JSON.stringify({ stop_reason: "pause_turn", content: [{ type: "web_search_tool_result", content: urls.map((url) => ({ type: "web_search_result", url })) }] }), { status: 200 });
    if (calls.length === 2) return new Response(JSON.stringify({ content: [{ type: "text", text: "A resumed source-backed answer. [1] [2] [3]" }] }), { status: 200 });
    return response();
  } });
  const result = await researcher.research({ kind: "market-brief", topic: "Sui" });
  assert.equal(result.citations.length, 3);
  assert.equal(calls.length, 3);
  assert.equal(calls[1]!.messages[1].role, "assistant");
  assert.equal(calls[1]!.messages[2].role, "user");
  assert.deepEqual(calls[2]!.tool_choice, { type: "tool", name: "submit_research" });
});

test("seller research repairs a malformed structured submission once", async () => {
  let calls = 0;
  const researcher = new ClaudeSellerResearcher({ apiKey: "test", fetch: async () => ++calls === 1 ? response({ ...draft, preview: JSON.stringify(draft.preview) }) : response() });
  const result = await researcher.research({ kind: "market-brief", topic: "Sui" });
  assert.equal(result.preview.sourceQuality, draft.preview.sourceQuality);
  assert.equal(calls, 2);
});

test("seller research fails closed when Anthropic reports a search error", async () => {
  const researcher = new ClaudeSellerResearcher({ apiKey: "test", fetch: async () => new Response(JSON.stringify({ content: [{ type: "web_search_tool_result", is_error: true, content: { type: "web_search_tool_result_error", error_code: "unavailable" } }] }), { status: 200 }) });
  await assert.rejects(() => researcher.research({ kind: "competitor-analysis", topic: "Sui competitors" }), { code: "SELLER_RESEARCH_SEARCH_FAILED" });
});

test("seller research enforces an optional source-domain allowlist", async () => {
  const researcher = new ClaudeSellerResearcher({ apiKey: "test", allowedDomains: ["sui.io"], fetch: async () => response() });
  await assert.rejects(() => researcher.research({ kind: "market-brief", topic: "Sui" }), { code: "SELLER_RESEARCH_SOURCE_UNAPPROVED" });
});

test("seller research rejects listed sources that are not cited inline", async () => {
  const uncited = { ...draft, body: draft.body.replace("[3]", "") };
  const researcher = new ClaudeSellerResearcher({ apiKey: "test", fetch: async () => response(uncited) });
  await assert.rejects(() => researcher.research({ kind: "market-brief", topic: "Sui" }), { code: "SELLER_RESEARCH_INVALID" });
});

test("seller research removes unused bibliography entries and renumbers markers", async () => {
  const extra = "https://example.com/unused", evidence = [...urls, extra];
  const researcher = new ClaudeSellerResearcher({ apiKey: "test", fetch: async () => new Response(JSON.stringify({ content: [{ type: "web_search_tool_result", content: evidence.map((url) => ({ type: "web_search_result", url })) }, { type: "tool_use", name: "submit_research", input: { ...draft, citations: [urls[0], extra, urls[1], urls[2]], body: draft.body.replace("[2] [3]", "[3] [4]") } }] }), { status: 200 }) });
  const result = await researcher.research({ kind: "market-brief", topic: "Sui" });
  assert.deepEqual(result.citations, urls);
  assert.match(result.body, /\[1\] \[2\] \[3\]/);
});
