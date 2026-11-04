import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backend = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sdk = join(backend, "packages/sdk");
const root = mkdtempSync(join(tmpdir(), "supercuts-release-"));
const run = (program, args, cwd) => execFileSync(program, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
const rpc = (binary, request, cwd, env = {}) => new Promise((resolveResponse, reject) => {
  const child = spawn(binary, [], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", error = "";
  child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("\n")) { child.kill(); try { resolveResponse(JSON.parse(output.split("\n")[0])); } catch (cause) { reject(cause); } } });
  child.stderr.on("data", (chunk) => { error += chunk; });
  child.on("error", reject);
  child.on("close", (code) => { if (!output) reject(new Error(`${binary} exited ${code}: ${error}`)); });
  child.stdin.end(`${JSON.stringify(request)}\n`);
});

try {
  run("pnpm", ["build"], backend);
  run("pnpm", ["build"], sdk);
  run("pnpm", ["pack", "--pack-destination", root], backend);
  run("pnpm", ["pack", "--pack-destination", root], sdk);
  const tarballs = readdirSync(root).filter((name) => name.endsWith(".tgz"));
  const backendTar = join(root, tarballs.find((name) => name.includes("backend")) ?? "");
  const sdkTar = join(root, tarballs.find((name) => name.includes("sdk")) ?? "");
  assert.ok(backendTar.endsWith(".tgz") && sdkTar.endsWith(".tgz") && backendTar !== sdkTar);
  for (const [tarball, required] of [[backendTar, "package/dist/seam.js"], [sdkTar, "package/dist/index.js"]]) {
    const files = run("tar", ["-tzf", tarball], root).trim().split("\n");
    assert.ok(files.includes(required), `${tarball} lacks ${required}`);
    assert.ok(files.includes("package/LICENSE"), `${tarball} lacks LICENSE`);
    assert.ok(files.every((file) => /^package\/(dist\/|README\.md$|LICENSE$|package\.json$)/.test(file)), `${tarball} contains unexpected files`);
  }
  const packedSdk = JSON.parse(run("tar", ["-xOzf", sdkTar, "package/package.json"], root));
  const packedBackend = JSON.parse(run("tar", ["-xOzf", backendTar, "package/package.json"], root));
  assert.equal(packedSdk.dependencies["@supercuts-walrus/backend"], packedBackend.version);
  assert.equal(packedSdk.version, packedBackend.version);
  const project = join(root, "consumer");
  run("mkdir", [project], root);
  writeFileSync(join(project, "package.json"), '{"private":true,"type":"module"}\n');
  // Seed the unpublished backend tarball locally, then install only the SDK tarball.
  run("npm", ["install", "--no-audit", "--no-fund", backendTar], project);
  run("npm", ["install", "--no-audit", "--no-fund", sdkTar], project);
  const installed = JSON.parse(readFileSync(join(project, "node_modules/@supercuts-walrus/backend/package.json"), "utf8"));
  assert.equal(installed.version, packedSdk.version);
  const bin = join(project, "node_modules/.bin");
  assert.match(run(join(bin, "supercuts"), ["help"], project), /setup buyer/);
  const noProfile = await rpc(join(bin, "supercuts-mcp"), { jsonrpc: "2.0", id: 1, method: "tools/list" }, project, { SUPERCUTS_HOME: join(root, "unconfigured") });
  assert.deepEqual(noProfile.result.tools.map((tool) => tool.name), ["setup.status"]);
  const seam = await rpc(join(bin, "supercuts-seam"), { protocol: 1, requestId: "release", method: "version" }, project);
  assert.equal(seam.result.packageVersion, packedSdk.version);
  const malformedSeam = await rpc(join(bin, "supercuts-seam"), { protocol: 1, requestId: "bad", method: "initialize", home: join(root, "invalid"), params: [] }, project);
  assert.equal(malformedSeam.error.code, "SEAM_REQUEST_INVALID");
  const malformedMcp = await rpc(join(bin, "supercuts-mcp"), { jsonrpc: "2.0", id: 3, method: "tools/list", params: [] }, project, { SUPERCUTS_HOME: join(root, "unconfigured") });
  assert.equal(malformedMcp.error.code, -32600);
  const moduleUrl = new URL(`file://${join(project, "node_modules/@supercuts-walrus/sdk/dist/index.js")}`);
  const { initializeProfile, BuyerClient } = await import(moduleUrl.href);
  const home = join(root, "buyer");
  await initializeProfile({ home }, { role: "buyer", mock: true });
  const buyer = await BuyerClient.connect({ home, approvalProvider: { async approve() { return { approved: true }; } } });
  const receipt = await buyer.deposit(10n);
  assert.equal(receipt.evidence, "deterministic-mock-not-funded");
  const roleTools = await rpc(join(bin, "supercuts-mcp"), { jsonrpc: "2.0", id: 2, method: "tools/list" }, project, { SUPERCUTS_HOME: home });
  assert.ok(roleTools.result.tools.some((tool) => tool.name === "wallet.deposit"));
  assert.ok(!roleTools.result.tools.some((tool) => tool.name === "audit.verify"));
  process.stdout.write(`Release gate passed: ${packedSdk.version}; CLI, seam, setup MCP, role MCP, SDK mock workflow.\n`);
} finally {
  if (process.env.SUPERCUTS_KEEP_RELEASE_GATE !== "1") rmSync(root, { recursive: true, force: true });
}
