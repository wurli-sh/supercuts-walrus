#!/usr/bin/env node
// Packs the v2 runtime proving files from circuits/build/v2 as flat GitHub Release assets and writes the pinned
// index shipped in the npm package (config/proofs-v2.json). Usage: node scripts/pack-proofs.mjs <asset-output-dir>
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(backend, "../circuits/build/v2");
const output = resolve(process.argv[2] ?? join(backend, ".proofs-release"));
const repo = "wurli-sh/supercuts-walrus", tag = "proofs-v2";
const deployment = JSON.parse(readFileSync(join(backend, "../config/phase1.testnet.json"), "utf8"));

const paths = ["proving-manifest.json"];
for (const circuit of ["deposit", "transfer", "withdraw"]) {
  const name = `${circuit}_v2`;
  paths.push(`${name}_js/generate_witness.js`, `${name}_js/witness_calculator.js`, `${name}_js/${name}.wasm`);
  paths.push(`proofs/${name}/${name}.zkey`, `proofs/${name}/verifying-key.bin`, `proofs/${name}/verification-key.json`);
}

mkdirSync(output, { recursive: true });
const files = paths.map((path) => {
  const body = readFileSync(join(source, path)), sha256 = createHash("sha256").update(body).digest("hex");
  const asset = path.replaceAll("/", "--");
  copyFileSync(join(source, path), join(output, asset));
  return { path, asset, size: statSync(join(source, path)).size, sha256 };
});

// The release must carry exactly the keys the pinned Testnet verifier was deployed with.
for (const [circuit, pinned] of Object.entries(deployment.artifacts)) {
  const name = `${circuit}_v2`, find = (path) => files.find((file) => file.path === path)?.sha256;
  if (find(`proofs/${name}/${name}.zkey`) !== pinned.zkeySha256 || find(`proofs/${name}/verifying-key.bin`) !== pinned.verifyingKeySha256) throw new Error(`${circuit} artifacts differ from config/phase1.testnet.json`);
}

const index = { version: "supercuts.proofs.v2", githubRepo: repo, tag, baseUrl: `https://github.com/${repo}/releases/download/${tag}`, files };
writeFileSync(join(backend, "config/proofs-v2.json"), `${JSON.stringify(index, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, output, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) })}\n`);
