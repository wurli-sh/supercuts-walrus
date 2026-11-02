import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v2 = process.argv.includes("--v2");
const build = resolve(root, "build", ...(v2 ? ["v2"] : []));
mkdirSync(build, { recursive: true });
const manifest = { version: v2 ? "supercuts-pool-v2" : "supercuts-phase1-v1", testOnly: true, circuits: {} };

for (const name of ["deposit", "transfer", "withdraw"]) {
  const source = `${name}${v2 ? "_v2" : ""}`;
  execFileSync("circom", [`${source}.circom`, "--r1cs", "--wasm", "--sym", "-l", "node_modules", "-o", build], {
    cwd: root,
    stdio: "inherit",
  });
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  manifest.circuits[name] = {
    r1csSha256: hash(resolve(build, `${source}.r1cs`)),
    wasmSha256: hash(resolve(build, `${source}_js/${source}.wasm`)),
    symSha256: hash(resolve(build, `${source}.sym`)),
  };
}

writeFileSync(resolve(build, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

