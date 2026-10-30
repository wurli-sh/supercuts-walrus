import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = resolve(root, "build");
mkdirSync(build, { recursive: true });
const manifest = { version: "supercuts-phase1-v1", testOnly: true, circuits: {} };

for (const name of ["deposit", "transfer", "withdraw"]) {
  execFileSync("circom", [`${name}.circom`, "--r1cs", "--wasm", "--sym", "-l", "node_modules", "-o", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  manifest.circuits[name] = {
    r1csSha256: hash(resolve(build, `${name}.r1cs`)),
    wasmSha256: hash(resolve(build, `${name}_js/${name}.wasm`)),
    symSha256: hash(resolve(build, `${name}.sym`)),
  };
}

writeFileSync(resolve(build, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

