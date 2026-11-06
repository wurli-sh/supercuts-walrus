# Supercuts TypeScript SDK

Supercuts gives agents private negotiation and settlement tools, with Walrus
Memory to carry policy and outcome context into later deals. The SDK exposes
that workflow through typed role clients while the runtime enforces the owner's
mandate and verifies payment evidence.

`@supercuts-walrus/sdk` is a typed, role-scoped wrapper over the one-request Supercuts
subprocess seam. Wallet keys, state keys, witnesses, and service credentials stay
inside the Supercuts process; the SDK receives intents and verified receipts.

## Quick start: a new buyer on Testnet

You need Node 22.13 or later and a Tatum API key. To use Walrus Memory you also need a Walrus Memory
account (a delegate key, an account ID, and a Sui private key for client-side encryption) and
[Ollama](https://ollama.com) with `embeddinggemma`.

**1. Install.** The SDK installs the matching backend runtime. pnpm 10 and later block dependency build
scripts by default, so allow `blake-hash` once. Its JavaScript fallback also works, but with pnpm 11 the
blocked build makes `pnpm exec` refuse to run.

```sh
mkdir my-buyer && cd my-buyer && pnpm init
printf 'allowBuilds:\n  blake-hash: true\n' > pnpm-workspace.yaml
pnpm add @supercuts-walrus/sdk@0.1.5 @supercuts-walrus/backend@0.1.5
```

Add the backend explicitly. It provides the `supercuts`, `supercuts-embedding-adapter`, and
`supercuts-memory-worker` commands, and pnpm only links commands from direct dependencies. With npm, run
`npm install @supercuts-walrus/sdk@0.1.5 @supercuts-walrus/backend@0.1.5` instead; npm needs no build approval.

**2. Store credentials in owner-only files.** Never paste them into an agent.

```sh
umask 077 && mkdir -p credentials
printf '%s\n' "$TATUM_API_KEY" > credentials/tatum.key
cat > credentials/memory.json <<JSON
{ "key": "$MEMWAL_DELEGATE_KEY", "accountId": "$MEMWAL_ACCOUNT_ID", "suiPrivateKey": "$MEMWAL_SUI_PRIVATE_KEY" }
JSON
```

Those three fields are all the Memory config needs. Supercuts fills in the Mainnet relayer, package,
registry, and local adapter defaults, and gives each role its own namespace.

**3. Start the embedding adapter** and leave it running. It pads local 768-dimensional vectors to the
1536 dimensions that Walrus Memory requires:

```sh
ollama pull embeddinggemma
pnpm exec supercuts-embedding-adapter
```

**4. Onboard the buyer.** Leave out any endpoint to use the public Testnet defaults and the shared
seller directory:

```sh
cat > buyer-setup.json <<JSON
{ "tatumKeyFile": "credentials/tatum.key", "memoryConfigFile": "credentials/memory.json",
  "perDealCeiling": "2000000", "totalBudget": "10000000",
  "expiresAt": $(( $(date +%s) * 1000 + 14 * 86400000 )), "allowPublicX402": true }
JSON
pnpm exec supercuts onboard buyer --home ./buyer --config buyer-setup.json
```

The output prints the generated buyer address and `nextSteps`. Fund only that address with Testnet SUI,
using `supercuts funding execute … --request-faucet --confirm` or <https://faucet.sui.io>. Then review the
directory and approve sellers:

```sh
curl -s https://supercuts-sellers-testnet.onrender.com/v2/directory/catalog
pnpm exec supercuts policy approve-seller --home ./buyer --capability-id market-brief-public-v2
pnpm exec supercuts onboarding doctor --home ./buyer
```

The npm package has everything public x402 payments need. For shielded (private) payments, install
the hash-pinned v2 proving keys once per machine (about 370 MB):

```sh
pnpm exec supercuts proofs install
pnpm exec supercuts proofs status
```

The command downloads every file from the pinned `proofs-v2` release, checks each SHA-256 against the
index shipped in the package, and only then installs them in `~/.supercuts/proofs/v2` (override with
`SUPERCUTS_PROOFS_DIR`). Until then the doctor reports `shielded-proofs` as `unavailable`. Proofs use
the bundled SnarkJS; set `SUPERCUTS_RAPIDSNARK` to a RapidSnark binary for faster proving.

When the owner stores a privacy rule for a seller (`supercuts policy add --home ./buyer --capability-id <id>`), that Walrus Memory
outranks an agent's `requestedRail: "x402"`: the deal settles through the shielded pool instead, and
the evidence shows `memoryInfluence.changedRail` with reason `MEMORY_PRIVACY_OVERRODE_RAIL`.

**5. Run a deal.**

```ts
import { BuyerClient } from "@supercuts-walrus/sdk";

const buyer = await BuyerClient.connect({ home: "./buyer", timeoutMs: 180_000 });
const deal = await buyer.executeDeal({
  operationId: "first-brief",                    // stable: reuse it to resume, never to pay twice
  capabilityClass: "sui.market-brief",           // Walrus Memory ranks the matching sellers
  input: { query: "Sui DeFi liquidity risks" },  // must fit the seller's signed input schema
  budget: { asset: "0x2::sui::SUI", maximum: "1000000" },
  requestedRail: "x402",
});
const evidence = await buyer.getDealEvidence(deal.dealId); // includes memoryInfluence
const delivery = await buyer.getDealDelivery(deal.dealId);
```

Pick `input` from the seller's signed `inputSchema` (`buyer.listDealCapabilities()`). Discovery ignores
sellers whose schema rejects your input. If a payment hits a transient seller-side outage, the error is
`retryable`: call `executeDeal` or `resumeDeal` again with the **same** `operationId`. Never start a second
payment.

An MCP agent session flushes outcome memories in the background. An SDK-only host keeps the worker running
next to the adapter, otherwise deals stay at `outcomeMemory: "pending"`:

```sh
pnpm exec supercuts-memory-worker ./buyer
```

Each finished deal writes a verified outcome to Walrus Memory. The next deal recalls it when choosing a
seller, a rail, and a spend ceiling. `pnpm exec supercuts memory insights --home ./buyer` shows what the
buyer has learned.

## Lower-level API

```ts
import { BuyerClient, initializeProfile } from "@supercuts-walrus/sdk";

await initializeProfile({ home: "/private/buyer" }, { role: "buyer", mock: true });
const buyer = await BuyerClient.connect({
  home: "/private/buyer",
  approvalProvider: {
    async approve(intent) {
      // Show intent.summary and intent.parameters in trusted operator UI.
      return { approved: true };
    },
  },
});
const receipt = await buyer.deposit(100n);
```

Mock receipts are always labeled as non-funded. The approval provider belongs in
trusted host code, outside model-controlled tool arguments.

For Testnet, initialize with `deploymentConfig`, owner-only `suiKeyFile` and
`tatumKeyFile`, and the write/Tatum gRPC endpoints instead of `mock: true`.
Live buyer methods include operation-bound deposit/withdrawal, accepted shielded
agreement settlement, and `payX402Resource(operationId, resourceUrl)`. The x402
method obtains amount, asset, and payee from the resource's 402 challenge; it
does not accept caller-supplied payment requirements.

Use `planSettlement(...)` before negotiation or payment when the owner mandate
requires plans, then pass the returned `planHash` to `payX402Resource`,
`payX402`, `settleShielded`, or `settleAcceptedShielded`. Typed
`rememberSettlement` writes are always assigned `agent_observation` provenance;
they can be cited but cannot expand authority or act as owner policy. Recall
returns blob ID, kind, provenance, and distance only, never decrypted text.

Unsupported live role commands fail closed with `LIVE_COMMAND_UNAVAILABLE`.
Mock and Testnet receipts remain distinct.
