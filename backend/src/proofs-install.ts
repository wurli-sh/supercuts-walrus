/**
 * Shielded proving artifacts for npm installs (`supercuts proofs install|status`).
 *
 * The v2 proving keys are about 370 MB, too large for the npm tarball. The package pins every runtime file by
 * SHA-256 in `config/proofs-v2.json`; this module downloads them from the pinned GitHub Release (or a local copy
 * or mirror), verifies each one, and installs them atomically in `~/.supercuts/proofs/v2`. A download host cannot
 * substitute a file: anything that differs from the pinned hash is rejected before it is installed.
 */
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { fail } from "./errors.js";

export interface ProofFile {
  path: string;
  asset: string;
  size: number;
  sha256: string;
}
export interface ProofIndex {
  version: "supercuts.proofs.v2";
  githubRepo: string;
  tag: string;
  baseUrl: string;
  files: ProofFile[];
}

const MARKER = ".supercuts-proofs";
const SAFE_PATH =
  /^(?:[a-z0-9_]+_js\/[a-z0-9_.]+|proofs\/[a-z0-9_]+\/[a-z0-9_.-]+|proving-manifest\.json)$/;

export function bundledProofIndexPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../config/proofs-v2.json",
  );
}

export function loadProofIndex(path = bundledProofIndexPath()): ProofIndex {
  const index = JSON.parse(readFileSync(path, "utf8")) as ProofIndex;
  if (
    index.version !== "supercuts.proofs.v2" ||
    !Array.isArray(index.files) ||
    !index.files.length
  )
    fail(
      "PROOF_INDEX_INVALID",
      "proof index is not a supercuts.proofs.v2 index",
    );
  for (const file of index.files)
    if (
      !SAFE_PATH.test(file.path) ||
      file.path.includes("..") ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      !/^[A-Za-z0-9_.-]+$/.test(file.asset)
    )
      fail("PROOF_INDEX_INVALID", `proof index entry ${file.path} is invalid`);
  return index;
}

/** `SUPERCUTS_PROOFS_DIR`, else `~/.supercuts/proofs/v2`. */
export function defaultProofsDir(): string {
  return process.env.SUPERCUTS_PROOFS_DIR
    ? resolve(process.env.SUPERCUTS_PROOFS_DIR)
    : join(homedir(), ".supercuts", "proofs", "v2");
}

const sha256File = async (path: string) => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

export async function proofsStatus(
  dir = defaultProofsDir(),
  index = loadProofIndex(),
): Promise<{
  dir: string;
  installed: boolean;
  missing: string[];
  mismatched: string[];
}> {
  const missing: string[] = [],
    mismatched: string[] = [];
  for (const file of index.files) {
    const path = join(dir, file.path);
    if (!existsSync(path)) missing.push(file.path);
    else if (
      statSync(path).size !== file.size ||
      (await sha256File(path)) !== file.sha256
    )
      mismatched.push(file.path);
  }
  return {
    dir,
    installed: !missing.length && !mismatched.length,
    missing,
    mismatched,
  };
}

interface Download {
  body: Readable;
  close?: () => void;
}
type Fetch = typeof fetch;

async function githubAssetUrls(
  index: ProofIndex,
  token: string,
  fetchImpl: Fetch,
): Promise<Map<string, string>> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${index.githubRepo}/releases/tags/${encodeURIComponent(index.tag)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "supercuts-proofs",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    fail(
      "PROOF_DOWNLOAD_FAILED",
      `GitHub release ${index.tag} lookup returned HTTP ${response.status}`,
    );
  const release = (await response.json()) as {
    assets?: Array<{ name: string; url: string }>;
  };
  return new Map(
    (release.assets ?? []).map((asset) => [asset.name, asset.url]),
  );
}

/**
 * Installs every pinned file into `dir`. Files are written to a sibling staging directory and only moved into
 * place after every hash matches, so a failed or tampered download never leaves a half-installed tree.
 */
export async function installProofs(
  options: {
    dir?: string;
    source?: string;
    index?: ProofIndex;
    fetchImpl?: Fetch;
    token?: string;
    onProgress?: (file: ProofFile) => void;
  } = {},
): Promise<Record<string, unknown>> {
  const index = options.index ?? loadProofIndex(),
    dir = resolve(options.dir ?? defaultProofsDir()),
    fetchImpl = options.fetchImpl ?? fetch;
  const before = await proofsStatus(dir, index);
  if (before.installed)
    return { dir, alreadyInstalled: true, files: index.files.length };
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const source = options.source,
    local =
      source && !/^https?:\/\//i.test(source) ? resolve(source) : undefined;
  const assets =
    !source && token
      ? await githubAssetUrls(index, token, fetchImpl)
      : undefined;
  // Never replace a directory this installer did not create: --dir or SUPERCUTS_PROOFS_DIR could name $HOME.
  if (existsSync(dir) && readdirSync(dir).length && !existsSync(join(dir, MARKER)))
    fail("PROOFS_DIR_UNSAFE", `${dir} is not empty and was not created by supercuts proofs install; choose an empty or new directory`);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const lock = `${dir}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch {
    // A lock older than the longest possible download belongs to a killed install.
    if (Date.now() - statSync(lock).mtimeMs < 2 * 60 * 60_000) fail("PROOFS_INSTALL_BUSY", `another proofs install holds ${lock}; wait for it or remove the lock if no install is running`);
  }
  const staging = `${dir}.partial`, previous = `${dir}.previous`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  let bytes = 0;
  try {
    for (const file of index.files) {
      options.onProgress?.(file);
      const target = join(staging, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const existing = join(dir, file.path);
      let input: Download;
      if (
        existsSync(existing) &&
        !before.missing.includes(file.path) &&
        !before.mismatched.includes(file.path)
      )
        input = { body: createReadStream(existing) };
      else if (local)
        input = { body: createReadStream(join(local, file.path)) };
      else {
        const assetUrl = assets?.get(file.asset);
        if (assets && !assetUrl)
          fail(
            "PROOF_DOWNLOAD_FAILED",
            `release ${index.tag} has no asset ${file.asset}`,
          );
        const url =
          assetUrl ??
          `${(source ?? index.baseUrl).replace(/\/$/, "")}/${file.asset}`;
        const response = await fetchImpl(url, {
          headers: {
            "user-agent": "supercuts-proofs",
            ...(assetUrl
              ? {
                  accept: "application/octet-stream",
                  authorization: `Bearer ${token}`,
                }
              : {}),
          },
          redirect: "follow",
          signal: AbortSignal.timeout(30 * 60_000),
        });
        if (!response.ok || !response.body)
          fail(
            "PROOF_DOWNLOAD_FAILED",
            `${file.asset} returned HTTP ${response.status}${response.status === 404 && !token ? "; set GITHUB_TOKEN while the release repository is private" : ""}`,
          );
        input = {
          body: Readable.fromWeb(
            response.body as import("node:stream/web").ReadableStream,
          ),
        };
      }
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > file.size)
            return done(new Error("file is larger than pinned"));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      try {
        await pipeline(
          input.body,
          meter,
          createWriteStream(target, { mode: 0o600 }),
        );
      } catch (error) {
        if (size > file.size) fail("ARTIFACT_HASH_MISMATCH", `${file.path} is larger than its pinned size`, error);
        fail("PROOF_DOWNLOAD_FAILED", `${file.path} could not be read or downloaded; retry the install`, error);
      }
      if (size !== file.size || hash.digest("hex") !== file.sha256)
        fail(
          "ARTIFACT_HASH_MISMATCH",
          `${file.path} does not match the pinned SHA-256`,
        );
      bytes += size;
    }
    writeFileSync(join(staging, MARKER), `${index.version}\n`, { mode: 0o600 });
    // Move the old install aside before swapping, so an interruption leaves either install recoverable.
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(dir)) renameSync(dir, previous);
    renameSync(staging, dir);
    chmodSync(dir, 0o700);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(dir) && existsSync(previous)) renameSync(previous, dir);
    throw error;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  return { dir, installed: true, files: index.files.length, bytes };
}

const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Locates the SnarkJS CLI shipped as a backend dependency (pnpm does not link bins of transitive dependencies). */
export function bundledSnarkjsCli(): string | undefined {
  try {
    let directory = dirname(createRequire(import.meta.url).resolve("snarkjs"));
    while (
      !existsSync(join(directory, "package.json")) &&
      dirname(directory) !== directory
    )
      directory = dirname(directory);
    const cli = join(directory, "build", "cli.cjs");
    return existsSync(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runtime prover paths. Profiles written by older releases point at a repository checkout that npm installs do
 * not have; those paths are kept only when they exist, otherwise the installed proofs and bundled tools are used.
 */
export function resolveProverPaths(
  stored: {
    artifactRoot: string;
    snarkjsPath: string;
    converterPath: string;
    rapidsnarkPath?: string;
  },
  artifactName: string,
): {
  artifactRoot: string;
  snarkjsPath: string;
  converterPath: string;
  rapidsnarkPath?: string;
} {
  const hasKeys = (root: string) =>
    Boolean(root) &&
    existsSync(join(root, "proofs", artifactName, `${artifactName}.zkey`));
  const artifactRoot = hasKeys(stored.artifactRoot)
    ? stored.artifactRoot
    : hasKeys(defaultProofsDir())
      ? defaultProofsDir()
      : stored.artifactRoot;
  const snarkjsPath = isExecutable(stored.snarkjsPath)
    ? stored.snarkjsPath
    : (bundledSnarkjsCli() ?? stored.snarkjsPath);
  const converterPath = isExecutable(stored.converterPath)
    ? stored.converterPath
    : "builtin";
  const rapidsnark = stored.rapidsnarkPath ?? process.env.SUPERCUTS_RAPIDSNARK;
  return {
    artifactRoot,
    snarkjsPath,
    converterPath,
    ...(rapidsnark ? { rapidsnarkPath: resolve(rapidsnark) } : {}),
  };
}
