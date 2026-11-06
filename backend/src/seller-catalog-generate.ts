#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCapabilityManifest } from "./capability.js";
import { fail } from "./errors.js";
import { parseArgs } from "./phase3.js";

const args = parseArgs(process.argv.slice(2));
const required = (name: string): string => typeof args[name] === "string" ? args[name] : fail("ARGUMENT_REQUIRED", `--${name} is required`);
const report = (name: string): { path: string; body: Buffer; data: Record<string, any>; hash: string } => {
  const path = resolve(required(name));
  if ((statSync(path).mode & 0o077) !== 0) fail("ARTIFACT_PERMISSIONS", `${name} report must be owner-only`);
  const body = readFileSync(path); if (!body.length || body.length > 10 * 1024 * 1024) fail("ARTIFACT_INVALID", `${name} report size is invalid`);
  let data: Record<string, any>; try { data = JSON.parse(body.toString()) as Record<string, any>; } catch (error) { return fail("ARTIFACT_INVALID", `${name} report must be JSON`, error); }
  return { path, body, data, hash: createHash("sha256").update(body).digest("hex") };
};
const price = (name: string) => { const value = required(name); if (!/^[1-9][0-9]*$/.test(value)) fail("PRICE_INVALID", `${name} must be positive MIST`); return value; };
try {
  const run = JSON.parse(readFileSync(resolve(required("run-json")), "utf8")) as { homes: Record<string, string>; addresses: Record<string, string> };
  const origin = new URL(required("seller-url"));
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(origin.hostname))) fail("SELLER_ORIGIN_INVALID", "seller URL must use HTTPS except on loopback");
  const briefA = report("brief-a"), briefB = report("brief-b"), analysisA = report("analysis-a"), analysisB = report("analysis-b");
  for (const item of [briefA, briefB, analysisA, analysisB]) if (item.data.reviewStatus !== "approved") fail("ARTIFACT_REVIEW_REQUIRED", `${item.path} must be owner-reviewed before live provisioning`);
  for (const brief of [briefA, briefB]) {
    if (typeof brief.data.title !== "string" || typeof brief.data.body !== "string" || !Array.isArray(brief.data.citations) || brief.data.citations.length < 2 || brief.data.citations.some((value: unknown) => typeof value !== "string" || !/^https:\/\//.test(value)) || new Set(brief.data.citations).size !== brief.data.citations.length || typeof brief.data.preview !== "object") fail("BRIEF_INVALID", "brief reports need title, body, unique HTTPS citations, and preview metadata");
    for (const key of ["relevance", "sourceQuality"]) if (typeof brief.data.preview[key] !== "number" || brief.data.preview[key] < 0 || brief.data.preview[key] > 1) fail("BRIEF_INVALID", `preview ${key} must be in [0,1]`);
    if (!Number.isFinite(brief.data.preview.freshnessDays) || brief.data.preview.freshnessDays < 0 || brief.data.preview.freshnessDays > 365) fail("BRIEF_INVALID", "preview freshnessDays is invalid");
  }
  for (const analysis of [analysisA, analysisB]) if (typeof analysis.data.title !== "string" || typeof analysis.data.body !== "string" || analysis.data.citations !== undefined && (!Array.isArray(analysis.data.citations) || analysis.data.citations.some((value: unknown) => typeof value !== "string" || !/^https:\/\//.test(value)))) fail("ANALYSIS_INVALID", "analysis reports need a title, body, and HTTPS citations when provided");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const capability = (id: string, sellerId: string, description: string, rails: Array<"x402" | "shielded">, amount: string) => createCapabilityManifest({ capabilityId: id, sellerId, capability: id === "competitor-analysis" ? "sui.competitor-analysis" : "sui.market-brief", description, inputSchema: { type: "object", properties: { topic: { type: "string" } } }, outputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, citations: { type: "array" } } }, supportedRails: rails, priceBand: { minimum: amount, maximum: amount }, asset: "0x2::sui::SUI", endpoint: new URL(`/resource/${id}`, origin).toString(), expiresAt });
  const publicA = run.addresses.publicSeller ?? fail("SELLER_CONFIG_INVALID", "first brief seller is missing"), publicB = run.addresses.secondPublicSeller ?? fail("SELLER_CONFIG_INVALID", "second brief seller is missing"), analysisSeller = run.addresses.confidentialSeller ?? fail("SELLER_CONFIG_INVALID", "analysis seller is missing");
  const manifestA = capability("market-brief-a", publicA, String(briefA.data.title), ["x402"], price("brief-a-price"));
  const manifestB = capability("market-brief-b", publicB, String(briefB.data.title), ["x402"], price("brief-b-price"));
  const manifestAnalysis = capability("competitor-analysis", analysisSeller, String(analysisA.data.title), ["x402", "shielded"], price("analysis-price"));
  const config = { sellers: [
    { sellerId: run.addresses.publicSeller, home: run.homes.publicSeller, capabilities: [{ manifest: manifestA, preview: { title: briefA.data.title, summary: briefA.data.preview.summary, citations: briefA.data.citations, relevance: briefA.data.preview.relevance, sourceQuality: briefA.data.preview.sourceQuality, freshnessDays: briefA.data.preview.freshnessDays }, artifact: briefA.path }] },
    { sellerId: run.addresses.secondPublicSeller, home: run.homes.secondPublicSeller, capabilities: [{ manifest: manifestB, preview: { title: briefB.data.title, summary: briefB.data.preview.summary, citations: briefB.data.citations, relevance: briefB.data.preview.relevance, sourceQuality: briefB.data.preview.sourceQuality, freshnessDays: briefB.data.preview.freshnessDays }, artifact: briefB.path }] },
    { sellerId: run.addresses.confidentialSeller, home: run.homes.confidentialSeller, capabilities: [{ manifest: manifestAnalysis, preview: { title: analysisA.data.title, summary: "Prepared competitor analysis matched to the purchased brief" }, variants: { [briefA.hash]: analysisA.path, [briefB.hash]: analysisB.path } }] },
  ] };
  const output = resolve(required("output")), workflow = resolve(required("workflow-output"));
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  writeFileSync(workflow, `${JSON.stringify({ capabilities: [manifestA, manifestB, manifestAnalysis] }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ config: output, workflow, briefHashes: [briefA.hash, briefB.hash], capabilityIds: [manifestA.capabilityId, manifestB.capabilityId, manifestAnalysis.capabilityId] })}\n`);
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "catalog generation failed"}\n`); process.exitCode = 1; }
