import { readFileSync, statSync } from "node:fs";
import { fail } from "./errors.js";

export interface DeploymentConfig {
  network: "testnet";
  chainId: string;
  packageId: string;
  poolId: string;
  coinType: string;
  coinTypeHash: string;
  deploymentDomain: string;
  verifierVersion: number;
  deploymentCheckpoint: bigint;
  initialRoot: string;
  tatumGrpcEndpoint: string;
  tatumApiKey: string;
  writeGrpcEndpoint: string;
  walrusPublisherUrl: string;
  walrusAggregatorUrl: string;
  x402FacilitatorUrl: string;
}

const HEX_32 = /^(?:0x)?[0-9a-f]{64}$/i;
const SUI_ID = /^0x[0-9a-f]{64}$/i;

export function parseDeploymentConfig(value: Record<string, unknown>): DeploymentConfig {
  const string = (key: string): string => {
    const result = value[key];
    if (typeof result !== "string" || !result.trim()) fail("CONFIG_INVALID", `${key} is required`);
    return result as string;
  };
  const checkpoint = string("deploymentCheckpoint");
  const verifierVersion = value.verifierVersion;
  const config: DeploymentConfig = {
    network: "testnet",
    chainId: string("chainId"), packageId: string("packageId"), poolId: string("poolId"),
    coinType: string("coinType"), coinTypeHash: string("coinTypeHash"),
    deploymentDomain: string("deploymentDomain"), verifierVersion: Number(verifierVersion),
    deploymentCheckpoint: BigInt(checkpoint), initialRoot: string("initialRoot"),
    tatumGrpcEndpoint: string("tatumGrpcEndpoint"), tatumApiKey: string("tatumApiKey"),
    writeGrpcEndpoint: string("writeGrpcEndpoint"), walrusPublisherUrl: string("walrusPublisherUrl"),
    walrusAggregatorUrl: string("walrusAggregatorUrl"), x402FacilitatorUrl: string("x402FacilitatorUrl"),
  };
  if (![config.packageId, config.poolId].every((id) => SUI_ID.test(id))) fail("CONFIG_INVALID", "packageId and poolId must be 32-byte Sui IDs");
  if (![config.coinTypeHash, config.deploymentDomain, config.initialRoot].every((hex) => HEX_32.test(hex))) fail("CONFIG_INVALID", "deployment hashes must be 32-byte hex values");
  if (!Number.isInteger(config.verifierVersion) || config.verifierVersion < 1) fail("CONFIG_INVALID", "verifierVersion must be a positive integer");
  if (config.deploymentCheckpoint < 0n) fail("CONFIG_INVALID", "deploymentCheckpoint cannot be negative");
  return config;
}

export function loadStateKey(path: string): Buffer {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) fail("STATE_KEY_PERMISSIONS", `state key ${path} must not be group/world accessible`);
  const raw = readFileSync(path);
  const key = /^[0-9a-fA-F]{64}\s*$/.test(raw.toString("utf8")) ? Buffer.from(raw.toString("utf8").trim(), "hex") : raw;
  if (key.length !== 32) fail("STATE_KEY_INVALID", "state key must contain exactly 32 bytes or 64 hex characters");
  return key;
}
