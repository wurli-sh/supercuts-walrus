import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bundledSnarkjsCli,
  installProofs,
  loadProofIndex,
  proofsStatus,
  resolveProverPaths,
  type ProofIndex,
} from "../src/proofs-install.js";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the shipped proof index pins exactly the keys the Testnet verifier was deployed with", () => {
  const index = loadProofIndex(),
    deployment = JSON.parse(
      readFileSync(join(backend, "config/phase1.testnet.json"), "utf8"),
    ) as {
      artifacts: Record<
        string,
        { zkeySha256: string; verifyingKeySha256: string }
      >;
    };
  for (const [circuit, pinned] of Object.entries(deployment.artifacts)) {
    const name = `${circuit}_v2`,
      find = (path: string) =>
        index.files.find((file) => file.path === path)?.sha256;
    assert.equal(find(`proofs/${name}/${name}.zkey`), pinned.zkeySha256);
    assert.equal(
      find(`proofs/${name}/verifying-key.bin`),
      pinned.verifyingKeySha256,
    );
    for (const path of [
      `${name}_js/generate_witness.js`,
      `${name}_js/witness_calculator.js`,
      `${name}_js/${name}.wasm`,
      `proofs/${name}/verification-key.json`,
    ])
      assert.ok(find(path), path);
  }
});

function fixture(): { source: string; index: ProofIndex } {
  const source = mkdtempSync(join(tmpdir(), "supercuts-proofs-src-"));
  const files = [
    ["proving-manifest.json", "{}"],
    ["proofs/transfer_v2/transfer_v2.zkey", "zkey-bytes"],
    ["transfer_v2_js/transfer_v2.wasm", "wasm-bytes"],
  ].map(([path, body]) => {
    mkdirSync(dirname(join(source, path!)), { recursive: true });
    writeFileSync(join(source, path!), body!);
    return {
      path: path!,
      asset: path!.replaceAll("/", "--"),
      size: Buffer.byteLength(body!),
      sha256: createHash("sha256").update(body!).digest("hex"),
    };
  });
  return {
    source,
    index: {
      version: "supercuts.proofs.v2",
      githubRepo: "example/repo",
      tag: "proofs-v2",
      baseUrl: "https://example.invalid/proofs",
      files,
    },
  };
}

test("install verifies every file, installs owner-only, and is idempotent", async () => {
  const { source, index } = fixture(),
    dir = join(mkdtempSync(join(tmpdir(), "supercuts-proofs-")), "v2");
  const first = await installProofs({ dir, source, index });
  assert.equal(first.installed, true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal((await proofsStatus(dir, index)).installed, true);
  assert.equal(
    (await installProofs({ dir, source, index })).alreadyInstalled,
    true,
  );
});

test("a tampered download is rejected and leaves nothing installed", async () => {
  const { source, index } = fixture(),
    dir = join(mkdtempSync(join(tmpdir(), "supercuts-proofs-")), "v2");
  writeFileSync(join(source, "transfer_v2_js/transfer_v2.wasm"), "wasm-bytez");
  await assert.rejects(
    installProofs({ dir, source, index }),
    /ARTIFACT_HASH_MISMATCH|pinned SHA-256/,
  );
  assert.equal(existsSync(dir), false);
});

test("downloads use the release URL and stream through the same verification", async () => {
  const { source, index } = fixture(),
    dir = join(mkdtempSync(join(tmpdir(), "supercuts-proofs-")), "v2"),
    urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const file = index.files.find((item) => url.endsWith(`/${item.asset}`))!;
    return new Response(readFileSync(join(source, file.path)));
  }) as unknown as typeof fetch;
  await installProofs({ dir, index, fetchImpl, token: "" });
  assert.deepEqual(
    urls,
    index.files.map((file) => `${index.baseUrl}/${file.asset}`),
  );
});

test("profiles from npm installs fall back to installed proofs and bundled tools", () => {
  const { source } = fixture();
  const paths = resolveProverPaths(
    {
      artifactRoot: "/nonexistent/config",
      snarkjsPath: "/nonexistent/.bin/snarkjs",
      converterPath: "/nonexistent/target/debug/supercuts-groth16",
    },
    "transfer_v2",
  );
  assert.equal(paths.converterPath, "builtin");
  assert.equal(
    paths.snarkjsPath,
    bundledSnarkjsCli() ?? "/nonexistent/.bin/snarkjs",
  );
  const previous = process.env.SUPERCUTS_PROOFS_DIR;
  process.env.SUPERCUTS_PROOFS_DIR = source;
  try {
    assert.equal(
      resolveProverPaths(
        {
          artifactRoot: "/nonexistent/config",
          snarkjsPath: "x",
          converterPath: "y",
        },
        "transfer_v2",
      ).artifactRoot,
      source,
    );
  } finally {
    if (previous === undefined) delete process.env.SUPERCUTS_PROOFS_DIR;
    else process.env.SUPERCUTS_PROOFS_DIR = previous;
  }
});

test("install refuses to replace a directory it did not create and labels read failures as download errors", async () => {
  const { source, index } = fixture(), foreign = mkdtempSync(join(tmpdir(), "supercuts-foreign-"));
  writeFileSync(join(foreign, "notes.txt"), "keep me");
  await assert.rejects(installProofs({ dir: foreign, source, index }), /PROOFS_DIR_UNSAFE|not created by/);
  assert.equal(readFileSync(join(foreign, "notes.txt"), "utf8"), "keep me");
  const dir = join(mkdtempSync(join(tmpdir(), "supercuts-proofs-")), "v2");
  await assert.rejects(installProofs({ dir, source: join(source, "missing"), index }), (error: Error & { code?: string }) => error.code === "PROOF_DOWNLOAD_FAILED");
  assert.equal(existsSync(`${dir}.lock`), false, "the lock is released after a failure");
});

test("a reinstall over a damaged install keeps verified files and replaces the rest", async () => {
  const { source, index } = fixture(), dir = join(mkdtempSync(join(tmpdir(), "supercuts-proofs-")), "v2");
  await installProofs({ dir, source, index });
  writeFileSync(join(dir, "proving-manifest.json"), "damaged");
  assert.equal((await installProofs({ dir, source, index })).installed, true);
  assert.equal((await proofsStatus(dir, index)).installed, true);
  assert.equal(existsSync(`${dir}.previous`), false); assert.equal(existsSync(`${dir}.partial`), false);
});
