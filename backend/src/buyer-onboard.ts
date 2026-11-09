import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  addBuyerPrivacyRule,
  approveBuyerSeller,
  askBuyerSetup,
  buyerSellerSource,
  fetchSellerListings,
  setupBuyerConfig,
  terminalAsk,
  validateConfig,
  type Ask,
  type BuyerSetup,
  type PrivacyRuleSelector,
  type SellerListing,
} from "./buyer-setup.js";
import { verifySignedCapability } from "./capability.js";
import { fail } from "./errors.js";
import { executeFunding } from "./funding.js";
import { loadMandate } from "./mandate.js";

export interface OnboardPlan {
  /** Standing policy for a new buyer; ignored when the buyer home already exists. */
  setup?: BuyerSetup;
  sellers: string[];
  privacyClasses: string[];
  funding: {
    publicPayment: string;
    shieldedPayment: string;
    requestFaucet: boolean;
  };
  /** Codex config.toml to receive the supercuts-buyer server; omit to skip. */
  codexConfig?: string;
}

export interface OnboardSteps {
  exists: (home: string) => boolean;
  setup: (home: string, config: BuyerSetup) => Record<string, unknown>;
  approve: (
    home: string,
    capabilityId: string,
  ) => Promise<Record<string, unknown>>;
  privacy: (
    home: string,
    selector: PrivacyRuleSelector,
  ) => Promise<Record<string, unknown>>;
  fund: (
    home: string,
    values: {
      publicPayment: string;
      shieldedPayment: string;
      operationId: string;
      requestFaucet: boolean;
      confirmed: boolean;
    },
  ) => Promise<Record<string, unknown>>;
  codex: (home: string, configPath: string) => Record<string, unknown>;
}

const defaultSteps: OnboardSteps = {
  exists: (home) => existsSync(join(home, "profile.json")),
  setup: setupBuyerConfig,
  approve: approveBuyerSeller,
  privacy: addBuyerPrivacyRule,
  fund: executeFunding,
  codex: writeCodexConfig,
};

/** `all` (or blank), `none`, or 1-based numbers such as `1,3`; returns 0-based indices. */
export function parseSelection(
  answer: string,
  count: number,
): "all" | "none" | number[] {
  const value = answer.trim().toLowerCase();
  if (!value || value === "all") return "all";
  if (value === "none") return "none";
  const picked = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const number = Number(item);
      if (!Number.isSafeInteger(number) || number < 1 || number > count)
        fail(
          "ONBOARD_SELECTION_INVALID",
          `choose numbers from 1 to ${count}, all, or none`,
        );
      return number - 1;
    });
  return [...new Set(picked)].sort((left, right) => left - right);
}

const pick = <T>(items: T[], selection: "all" | "none" | number[]): T[] =>
  selection === "all"
    ? items
    : selection === "none"
      ? []
      : selection.map((index) => items[index]!);

/** Capability classes that a privacy rule can bind: only those some chosen seller offers on the shielded rail. */
export function shieldedClasses(listings: SellerListing[]): string[] {
  return [
    ...new Set(
      listings
        .filter((listing) =>
          listing.registration.manifest.supportedRails.includes("shielded"),
        )
        .map((listing) => listing.registration.manifest.capability),
    ),
  ];
}

/** Replaces any existing supercuts-buyer stanza (and its sub-tables); every other table is kept as written. */
export function mergeCodexConfig(existing: string, stanza: string): string {
  const kept: string[] = [];
  let dropping = false;
  for (const line of existing.split("\n")) {
    if (/^\s*\[/.test(line))
      dropping = /^\s*\[mcp_servers\.supercuts-buyer(\.[^\]]*)?\]\s*$/.test(
        line,
      );
    if (!dropping) kept.push(line);
  }
  const head = kept.join("\n").replace(/\s+$/, "");
  return `${head ? `${head}\n\n` : ""}${stanza.replace(/\s+$/, "")}\n`;
}

/** Writes the buyer's generated Codex stanza, with its tool timeouts, into the Codex config after a backup. */
export function writeCodexConfig(
  home: string,
  configPath: string,
): Record<string, unknown> {
  const stanzaPath = join(home, "buyer-codex.toml");
  if (!existsSync(stanzaPath))
    fail(
      "SETUP_REQUIRED",
      "the buyer home has no generated Codex config; run setup first",
    );
  const path = resolve(configPath),
    exists = existsSync(path);
  const backup = exists ? `${path}.bak-${Date.now()}` : undefined;
  if (backup) copyFileSync(path, backup);
  const mode = exists ? statSync(path).mode & 0o777 : 0o600;
  writeFileSync(
    path,
    mergeCodexConfig(
      exists ? readFileSync(path, "utf8") : "",
      readFileSync(stanzaPath, "utf8"),
    ),
    { mode },
  );
  chmodSync(path, mode);
  return {
    codexConfig: path,
    ...(backup ? { backup } : {}),
    restartCodex:
      "quit every Codex session so the next one loads the new supercuts-buyer server",
  };
}

/** Walrus Memory needs 1536-dimension embeddings from the owner's local endpoint; check it before anything is created. */
export async function assertEmbeddingsReady(config: { embeddingApiBase: string; embeddingModel: string; embeddingApiKey?: string }, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = `${config.embeddingApiBase.replace(/\/+$/, "")}/embeddings`;
  let dims: number | undefined;
  try {
    const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...(config.embeddingApiKey ? { authorization: `Bearer ${config.embeddingApiKey}` } : {}) }, body: JSON.stringify({ model: config.embeddingModel, input: "supercuts onboarding probe" }), signal: AbortSignal.timeout(20_000) });
    dims = ((await response.json()) as { data?: Array<{ embedding?: unknown[] }> }).data?.[0]?.embedding?.length;
  } catch { fail("MEMORY_ENDPOINT_UNREACHABLE", `the embedding endpoint ${config.embeddingApiBase} is not answering; start supercuts-embedding-adapter (with EMBEDDING_UPSTREAM_BASE_URL and EMBEDDING_UPSTREAM_MODEL set), then rerun onboarding`); }
  if (dims !== 1536) fail("MEMORY_EMBEDDING_INVALID", `the embedding endpoint returned ${dims ?? "no"} dimensions; Walrus Memory needs 1536, so point the Memory config at supercuts-embedding-adapter`);
}
const memoryConfigOf = (setup: BuyerSetup | undefined): { embeddingApiBase: string; embeddingModel: string; embeddingApiKey?: string } | undefined =>
  setup?.memoryConfigFile ? JSON.parse(readFileSync(resolve(setup.memoryConfigFile), "utf8")) as { embeddingApiBase: string; embeddingModel: string; embeddingApiKey?: string } : undefined;

/** Runs each step in order; every step is idempotent, so a rerun resumes an interrupted onboarding. */
export async function runBuyerOnboarding(
  home: string,
  plan: OnboardPlan,
  steps: OnboardSteps = defaultSteps,
): Promise<Record<string, unknown>> {
  const resumed = steps.exists(home);
  if (!resumed && !plan.setup)
    fail("SETUP_REQUIRED", "a new buyer needs its standing policy");
  const setup = resumed ? undefined : steps.setup(home, plan.setup!);
  const approved: Record<string, unknown>[] = [];
  for (const capabilityId of plan.sellers)
    approved.push(await steps.approve(home, capabilityId));
  const privacyRules: Record<string, unknown>[] = [];
  for (const capabilityClass of plan.privacyClasses)
    privacyRules.push(await steps.privacy(home, { capabilityClass }));
  const { publicPayment, shieldedPayment, requestFaucet } = plan.funding;
  const funding =
    BigInt(publicPayment) > 0n || BigInt(shieldedPayment) > 0n
      ? await steps.fund(home, {
          publicPayment,
          shieldedPayment,
          operationId: "onboard-fund-1",
          requestFaucet,
          confirmed: true,
        })
      : undefined;
  const codex = plan.codexConfig
    ? steps.codex(home, plan.codexConfig)
    : undefined;
  return {
    home,
    resumed,
    ...(setup ? { address: setup.address, runId: setup.runId } : {}),
    approved: approved.map((item) => ({
      capabilityId: item.capabilityId,
      sellerId: item.sellerId,
      approved: item.approved,
    })),
    privacyRules: privacyRules.map((item) => ({
      capabilityClass: item.capabilityClass,
      coveredCapabilities: item.coveredCapabilities,
      blobId: item.blobId,
    })),
    ...(funding ? { funding } : {}),
    ...(codex ? { codex } : {}),
    nextSteps: [
      "Keep the Walrus Memory embedding adapter running (supercuts-embedding-adapter).",
      "Open one Codex session and describe the task; the deal tools explain themselves.",
    ],
  };
}

/** Listings whose seller signature verifies, so the owner chooses only from authentic offers. */
async function verifiedListings(source: {
  directoryUrl?: string;
  origins?: string[];
}): Promise<SellerListing[]> {
  const verified: SellerListing[] = [];
  for (const listing of await fetchSellerListings(source)) {
    try {
      await verifySignedCapability(listing.registration);
      verified.push(listing);
    } catch {
      /* an unsigned or altered listing is never offered */
    }
  }
  return verified;
}

export function describeListing(listing: SellerListing, index: number): string {
  const { manifest } = listing.registration;
  const price =
    manifest.priceBand.minimum === manifest.priceBand.maximum
      ? manifest.priceBand.minimum
      : `${manifest.priceBand.minimum}-${manifest.priceBand.maximum}`;
  return `${index + 1}. ${manifest.capabilityId} (${manifest.capability}), ${price} MIST, rails ${manifest.supportedRails.join("+")}, seller ${manifest.sellerId.slice(0, 10)}…: ${manifest.description}`;
}

/** Interactive onboarding: every question first, one summary, one confirmation, then all steps. */
export async function promptBuyerOnboarding(
  home: string,
): Promise<Record<string, unknown>> {
  const { ask, close } = terminalAsk();
  let plan: OnboardPlan;
  try {
    plan = await askOnboarding(home, ask);
  } finally {
    close();
  }
  return runBuyerOnboarding(home, plan);
}

async function askOnboarding(home: string, ask: Ask): Promise<OnboardPlan> {
  const say = (text: string) => process.stderr.write(`${text}\n`);
  const resumed = existsSync(join(home, "profile.json"));
  let setup: BuyerSetup | undefined,
    source: { directoryUrl?: string; origins?: string[] },
    ceiling: string,
    allowPublic: boolean;
  if (resumed) {
    say(`Resuming the existing buyer in ${home}; its standing policy is kept.`);
    const mandate = loadMandate(home);
    source = buyerSellerSource(home);
    ceiling = mandate.perDealCeiling;
    allowPublic = mandate.allowPublicX402 === true;
  } else {
    say(
      "Press Enter to accept a bracketed default. Credentials are read from owner-only files, never typed here.",
    );
    setup = await askBuyerSetup(ask, { askCounterparties: false });
    source = {
      ...(setup.directoryUrl ? { directoryUrl: setup.directoryUrl } : {}),
      origins: setup.sellerOrigins ?? [],
    };
    ceiling = setup.perDealCeiling;
    allowPublic = setup.allowPublicX402 === true;
  }
  const listings = await verifiedListings(source);
  if (!listings.length)
    fail(
      "SELLER_DIRECTORY_UNAVAILABLE",
      "no signed seller listings were found in the directory or seller origins",
    );
  say("\nSigned seller listings (a listing alone does not authorize payment):");
  listings.forEach((listing, index) =>
    say(`  ${describeListing(listing, index)}`),
  );
  const chosen = pick(
    listings,
    parseSelection(
      await ask("Approve which sellers? numbers like 1,3, all, or none", "all"),
      listings.length,
    ),
  );
  const classes = shieldedClasses(chosen);
  let privacyClasses: string[] = [];
  if (classes.length) {
    say("\nCapability classes these sellers offer privately:");
    classes.forEach((item, index) => say(`  ${index + 1}. ${item}`));
    privacyClasses = pick(
      classes,
      parseSelection(
        await ask(
          "Always settle these classes privately (shielded)? numbers, all, or none",
          "all",
        ),
        classes.length,
      ),
    );
  }
  const offersPublic =
    allowPublic &&
    chosen.some((listing) =>
      listing.registration.manifest.supportedRails.includes("x402"),
    );
  const offersShielded = chosen.some((listing) =>
    listing.registration.manifest.supportedRails.includes("shielded"),
  );
  const publicPayment = await ask(
    "Fund public x402 payments now, in MIST",
    offersPublic ? ceiling : "0",
  );
  const shieldedPayment = await ask(
    "Fund private shielded payments now, in MIST (deposited into the pool)",
    offersShielded ? ceiling : "0",
  );
  const requestFaucet =
    (
      await ask(
        "Request Testnet SUI from the faucet for this buyer? yes/no",
        "yes",
      )
    ).toLowerCase() === "yes";
  const codexAnswer = await ask(
    "Write the supercuts-buyer server into this Codex config (backed up first), or none",
    join(homedir(), ".codex", "config.toml"),
  );
  const plan: OnboardPlan = {
    ...(setup ? { setup } : {}),
    sellers: chosen.map(
      (listing) => listing.registration.manifest.capabilityId,
    ),
    privacyClasses,
    funding: { publicPayment, shieldedPayment, requestFaucet },
    ...(codexAnswer.toLowerCase() === "none"
      ? {}
      : { codexConfig: codexAnswer }),
  };
  say("\nAbout to:");
  if (setup)
    say(
      `  - create the buyer in ${home}: ${setup.perDealCeiling} MIST per deal, ${setup.totalBudget} MIST total, public x402 ${setup.allowPublicX402 ? "allowed" : "not allowed"}`,
    );
  say(
    `  - approve ${plan.sellers.length ? plan.sellers.join(", ") : "no sellers"}`,
  );
  say(
    `  - save a shielded-settlement rule to Walrus Memory for ${privacyClasses.length ? privacyClasses.join(", ") : "no classes"}`,
  );
  say(
    `  - fund ${publicPayment} MIST public and ${shieldedPayment} MIST shielded${requestFaucet ? ", requesting the Testnet faucet if short" : ""}`,
  );
  say(
    `  - ${plan.codexConfig ? `write the Codex config at ${plan.codexConfig}` : "leave the Codex config untouched"}`,
  );
  if ((await ask("Proceed? yes/no", "no")).toLowerCase() !== "yes")
    fail("ONBOARD_CANCELLED", "nothing was changed");
  const memory = memoryConfigOf(setup);
  if (privacyClasses.length && memory) await assertEmbeddingsReady(memory);
  return plan;
}

/**
 * Noninteractive onboarding from an owner-only JSON file: the setup keys plus an `onboarding` object
 * `{ sellers: "all" | string[], privacyClasses?: "all" | string[], funding?: {...}, codexConfig?: string }`.
 * A file without `onboarding` is plain setup, as before.
 */
export async function onboardBuyerFromConfig(
  home: string,
  configPath: string,
  confirmed: boolean,
  plainSetup: (home: string, path: string) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const path = resolve(configPath);
  if ((statSync(path).mode & 0o077) !== 0)
    fail("SETUP_CONFIG_PERMISSIONS", "onboarding config must be owner-only");
  const raw = JSON.parse(readFileSync(path, "utf8")) as BuyerSetup & {
    onboarding?: {
      sellers?: "all" | string[];
      privacyClasses?: "all" | string[];
      funding?: Partial<OnboardPlan["funding"]>;
      codexConfig?: string;
    };
  };
  if (!raw.onboarding) return plainSetup(home, path);
  if (!confirmed)
    fail(
      "ONBOARD_CONFIRMATION_REQUIRED",
      "noninteractive onboarding funds and approves sellers; rerun with --yes after reviewing the config",
    );
  const { onboarding, ...setupKeys } = raw;
  const resumed = existsSync(join(home, "profile.json"));
  const setup = resumed ? undefined : validateConfig(setupKeys as BuyerSetup);
  const source = resumed
    ? buyerSellerSource(home)
    : {
        ...(setup!.directoryUrl ? { directoryUrl: setup!.directoryUrl } : {}),
        origins: setup!.sellerOrigins ?? [],
      };
  const listings =
    onboarding.sellers === "all" || onboarding.privacyClasses === "all"
      ? await verifiedListings(source)
      : [];
  const sellers =
    onboarding.sellers === "all"
      ? listings.map((listing) => listing.registration.manifest.capabilityId)
      : (onboarding.sellers ?? []);
  const chosen = listings.filter((listing) =>
    sellers.includes(listing.registration.manifest.capabilityId),
  );
  const privacyClasses =
    onboarding.privacyClasses === "all"
      ? shieldedClasses(chosen)
      : (onboarding.privacyClasses ?? []);
  const memory = memoryConfigOf(setup);
  if (privacyClasses.length && memory) await assertEmbeddingsReady(memory);
  return runBuyerOnboarding(home, {
    ...(setup ? { setup } : {}),
    sellers,
    privacyClasses,
    funding: {
      publicPayment: String(onboarding.funding?.publicPayment ?? "0"),
      shieldedPayment: String(onboarding.funding?.shieldedPayment ?? "0"),
      requestFaucet: onboarding.funding?.requestFaucet === true,
    },
    ...(onboarding.codexConfig ? { codexConfig: onboarding.codexConfig } : {}),
  });
}

/** `policy approve-seller --all` or a comma-separated `--capability-id`; --all shows the listings and needs confirmation. */
export async function approveSellers(
  home: string,
  input: { all: boolean; capabilityIds: string[]; confirmed: boolean },
  approve = approveBuyerSeller,
): Promise<Record<string, unknown>> {
  let ids = input.capabilityIds;
  if (input.all) {
    const listings = await verifiedListings(buyerSellerSource(home));
    if (!listings.length)
      fail(
        "SELLER_DIRECTORY_UNAVAILABLE",
        "no signed seller listings were found",
      );
    process.stderr.write(
      `Signed seller listings:\n${listings.map((listing, index) => `  ${describeListing(listing, index)}`).join("\n")}\n`,
    );
    let confirmed = input.confirmed;
    if (!confirmed && process.stdin.isTTY) {
      const { ask, close } = terminalAsk();
      try {
        confirmed =
          (
            await ask(`Approve all ${listings.length} sellers? yes/no`, "no")
          ).toLowerCase() === "yes";
      } finally {
        close();
      }
    }
    if (!confirmed)
      fail(
        "ONBOARD_CONFIRMATION_REQUIRED",
        "review the listings above, then rerun with --yes to approve them all",
      );
    ids = listings.map((listing) => listing.registration.manifest.capabilityId);
  }
  if (!ids.length)
    fail(
      "ARGUMENT_REQUIRED",
      "--capability-id <id[,id...]> or --all is required",
    );
  const approved: Record<string, unknown>[] = [];
  for (const id of ids) approved.push(await approve(home, id));
  return ids.length === 1 && !input.all ? approved[0]! : { approved };
}
