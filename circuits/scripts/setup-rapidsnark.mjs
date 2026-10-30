import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "build/tools/rapidsnark-src");
const build = resolve(source, "build_prover");
const prover = resolve(build, "src/prover");
const tag = "v0.0.4";
const commit = "74dd3911e48f1a18605977bf2a12adb38222fd9c";

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

mkdirSync(dirname(source), { recursive: true });
if (!existsSync(resolve(source, ".git"))) {
  run("git", ["clone", "--depth", "1", "--branch", tag,
    "https://github.com/iden3/rapidsnark.git", source]);
}

const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
}).trim();
if (actualCommit !== commit) {
  throw new Error(`RapidSnark source mismatch: expected ${commit}, got ${actualCommit}`);
}

run("git", ["submodule", "update", "--init", "--recursive"], source);
const hasNasm = spawnSync("nasm", ["-v"], { stdio: "ignore" }).status === 0;
const cmakeArgs = [
  "-S", ".", "-B", build,
  `-DUSE_ASM=${hasNasm ? "ON" : "OFF"}`,
  "-DUSE_OPENMP=ON",
  "-DCMAKE_BUILD_TYPE=Release",
  // v0.0.4 needs this with newer GCC/libstdc++ versions.
  "-DCMAKE_CXX_FLAGS=-include cstdint",
];
run("cmake", cmakeArgs, source);
run("cmake", ["--build", build, "--target", "prover", "--parallel"], source);

if (!existsSync(prover)) throw new Error(`RapidSnark build did not produce ${prover}`);
console.log(`RapidSnark ${tag} (${commit}) ready: ${prover}`);
console.log(`assembly acceleration: ${hasNasm ? "enabled" : "disabled (generic safe build)"}`);
