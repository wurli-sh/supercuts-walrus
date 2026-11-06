import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Public Sui Testnet, Walrus Testnet, and hosted Supercuts endpoints used when an owner leaves a setup field blank.
 * None of these values are credentials; owners can still override every one in setup JSON or the prompts.
 */
export const TESTNET_DEFAULTS = {
  writeGrpc: "https://fullnode.testnet.sui.io:443",
  tatumGrpc: "https://sui-testnet-grpc.gateway.tatum.io:443",
  walrusPublisher: "https://publisher.walrus-testnet.walrus.space",
  walrusAggregator: "https://aggregator.walrus-testnet.walrus.space",
  directoryUrl: "https://supercuts-sellers-testnet.onrender.com",
} as const;

/** Pinned experimental v2 Testnet deployment metadata shipped inside the npm package. */
export function bundledDeploymentConfig(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../config/phase1.testnet.json",
  );
}

/** Fills blank endpoint fields with the public Testnet defaults. */
export function withTestnetDefaults<
  T extends {
    deploymentConfig?: string;
    writeGrpc?: string;
    tatumGrpc?: string;
    walrusPublisher?: string;
    walrusAggregator?: string;
  },
>(config: T): T {
  config.deploymentConfig ||= bundledDeploymentConfig();
  config.writeGrpc ||= TESTNET_DEFAULTS.writeGrpc;
  config.tatumGrpc ||= TESTNET_DEFAULTS.tatumGrpc;
  config.walrusPublisher ||= TESTNET_DEFAULTS.walrusPublisher;
  config.walrusAggregator ||= TESTNET_DEFAULTS.walrusAggregator;
  return config;
}
