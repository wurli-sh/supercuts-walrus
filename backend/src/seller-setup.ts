import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fail } from "./errors.js";
import { TESTNET_DEFAULTS, withTestnetDefaults } from "./testnet-defaults.js";
import { initialize } from "./phase3.js";

interface SellerSetup {
  deploymentConfig?: string;
  tatumKeyFile: string;
  writeGrpc: string;
  tatumGrpc: string;
  walrusPublisher: string;
  walrusAggregator: string;
  suiKeyFile?: string;
  snarkjs?: string;
  converter?: string;
  rapidsnark?: string;
}

function ownerFile(path: string): void {
  if ((statSync(path).mode & 0o077) !== 0) fail("SETUP_PERMISSIONS", `${path} must be owner-only`);
}

function validateConfig(config: SellerSetup): SellerSetup {
  withTestnetDefaults(config);
  for (const key of ["deploymentConfig", "tatumKeyFile", "writeGrpc", "tatumGrpc", "walrusPublisher", "walrusAggregator"] as const) {
    if (typeof config[key] !== "string" || !config[key]) fail("SETUP_INVALID", `${key} is required`);
  }
  ownerFile(resolve(config.tatumKeyFile));
  if (config.suiKeyFile) ownerFile(resolve(config.suiKeyFile));
  const deployment = JSON.parse(readFileSync(resolve(config.deploymentConfig!), "utf8")) as { verifierVersion?: number; network?: string; testOnly?: boolean };
  if (deployment.network !== "testnet" || deployment.testOnly !== true || deployment.verifierVersion !== 2) fail("SETUP_INVALID", "seller setup requires the pinned experimental v2 Testnet deployment");
  return config;
}

function readConfig(path: string): SellerSetup {
  ownerFile(path);
  return validateConfig(JSON.parse(readFileSync(path, "utf8")) as SellerSetup);
}

export function createSellerSession(home: string): Record<string, unknown> {
  if (!existsSync(join(home, "profile.json"))) fail("SETUP_REQUIRED", "initialize the seller before creating an agent session");
  const mcpScript = join(dirname(fileURLToPath(import.meta.url)), "mcp-bootstrap.js");
  const mcp = `[mcp_servers.supercuts-seller]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([mcpScript])}\n[mcp_servers.supercuts-seller.env]\nSUPERCUTS_HOME = ${JSON.stringify(home)}\n`;
  const mcpConfig = join(home, "seller-codex.toml");
  writeFileSync(mcpConfig, mcp, { mode: 0o600 });
  chmodSync(mcpConfig, 0o600);
  return { mcpConfig };
}

function setupSellerConfig(home: string, config: SellerSetup): Record<string, unknown> {
  if (existsSync(join(home, "profile.json"))) fail("PROFILE_EXISTS", "seller home already exists; create a separate home for another seller identity");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const keyPath = config.suiKeyFile ? resolve(config.suiKeyFile) : join(home, "seller.sui.key");
  if (!config.suiKeyFile) writeFileSync(keyPath, Ed25519Keypair.generate().getSecretKey(), { mode: 0o600, flag: "wx" });
  ownerFile(keyPath);
  initialize(home, {
    role: "seller",
    "deployment-config": resolve(config.deploymentConfig!),
    "sui-key-file": keyPath,
    "tatum-key-file": resolve(config.tatumKeyFile),
    "write-grpc": config.writeGrpc,
    "tatum-grpc": config.tatumGrpc,
    "walrus-publisher": config.walrusPublisher,
    "walrus-aggregator": config.walrusAggregator,
    ...(config.snarkjs ? { snarkjs: resolve(config.snarkjs) } : {}),
    ...(config.converter ? { converter: resolve(config.converter) } : {}),
    ...(config.rapidsnark ? { rapidsnark: resolve(config.rapidsnark) } : {}),
  });
  const decoded = decodeSuiPrivateKey(readFileSync(keyPath, "utf8").trim());
  if (decoded.scheme !== "ED25519") fail("SETUP_INVALID", "seller key must use ED25519");
  const address = Ed25519Keypair.fromSecretKey(decoded.secretKey).toSuiAddress();
  return {
    home,
    address,
    fundingRequired: false,
    warning: "Do not faucet-fund the seller. Only a generated buyer address is funded for live purchases.",
    ...createSellerSession(home),
    nextStep: `Run supercuts seller scaffold --home ${JSON.stringify(home)} --output <offer-dir> with the capability, origin, price, rails, and expiry options. Review the handler, then run the printed registration and service commands.`,
  };
}

export function setupSeller(home: string, configPath: string): Record<string, unknown> {
  return setupSellerConfig(home, readConfig(resolve(configPath)));
}

export async function promptSellerSetup(home: string): Promise<Record<string, unknown>> {
  if (!process.stdin.isTTY) fail("SETUP_INPUT_REQUIRED", "interactive seller setup requires a terminal; use --config with an owner-only JSON file");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ask = async (label: string, fallback?: string) => (await rl.question(fallback ? `${label} [${fallback}]: ` : `${label}: `)).trim() || fallback || "";
    process.stderr.write("Press Enter to accept a bracketed default. Credentials are read from owner-only files, never typed here.\n");
    const config: SellerSetup = {
      deploymentConfig: await ask("Pinned v2 Testnet deployment config path (blank for bundled config)"),
      tatumKeyFile: await ask("Owner-only Tatum API key file path"),
      writeGrpc: await ask("Sui write gRPC URL", TESTNET_DEFAULTS.writeGrpc),
      tatumGrpc: await ask("Tatum read gRPC URL", TESTNET_DEFAULTS.tatumGrpc),
      walrusPublisher: await ask("Walrus publisher URL", TESTNET_DEFAULTS.walrusPublisher),
      walrusAggregator: await ask("Walrus aggregator URL", TESTNET_DEFAULTS.walrusAggregator),
    };
    const snarkjs = await ask("SnarkJS executable path (blank for deployment-relative default)");
    const converter = await ask("Groth16 converter path (blank for deployment-relative default)");
    const rapidsnark = await ask("RapidSnark executable path (blank to use SnarkJS)");
    if (snarkjs) config.snarkjs = snarkjs;
    if (converter) config.converter = converter;
    if (rapidsnark) config.rapidsnark = rapidsnark;
    return setupSellerConfig(home, validateConfig(config));
  } finally {
    rl.close();
  }
}
