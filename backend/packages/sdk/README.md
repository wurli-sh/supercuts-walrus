# Supercuts TypeScript SDK

Supercuts gives agents private negotiation and settlement tools, with Walrus
Memory to carry policy and outcome context into later deals. The SDK exposes
that workflow through typed role clients while the runtime enforces the owner's
mandate and verifies payment evidence.

`@supercuts-walrus/sdk` is a typed, role-scoped wrapper over the one-request Supercuts
subprocess seam. Wallet keys, state keys, witnesses, and service credentials stay
inside the Supercuts process; the SDK receives intents and verified receipts.

Install the SDK. It installs the matching backend runtime automatically:

```sh
pnpm add @supercuts-walrus/sdk@0.1.2
```

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
