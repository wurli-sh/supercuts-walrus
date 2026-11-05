# Remote marketplace walkthrough with a Codex buyer

This walkthrough shows the Supercuts core flow end to end: agents negotiate privately,
settle on the public or shielded rail, and use Walrus Memory to carry an owner
privacy rule into the next payment decision. The memory recall must select the
shielded rail for the confidential analysis.

This path runs a buyer-only `supercuts-mcp` process in Codex. One Render web service hosts three separate seller identities: two prepared Sui market briefs and one competitor analysis with a prepared variant for each brief. The existing x402 facilitator remains a separate Render service. All payments use live Sui Testnet. The seller's research specialty is independent of the payment rail.

The hosted seller path queues the confidential seller's standard delayed exit through a separate owner command after artifact delivery. Use an unused state directory for fresh v2 role homes; the examples below use `.state/remote-demo-v2`. Rerunning setup in the older `.state/remote-demo` directory does not upgrade its v1 profiles or notes.

## Prepare the reports and roles

Use four owner-only JSON report files in the ignored `.secrets/` directory: two public briefs and two matching competitor analyses. Draft files are provided there for review. Each brief needs `title`, `body`, at least two HTTPS `citations`, and a `preview` object with `summary`, `relevance` and `sourceQuality` in `[0,1]`, and `freshnessDays` in `[0,365]`. Each analysis needs `title` and `body`. Review the claims and sources before recording, then change `reviewStatus` from `draft-needs-owner-review` in each approved file. The analysis files must stay private; the catalog generator records their hashes but does not publish their plaintext.

For example, a brief file has this shape:

```json
{
  "title": "Sui market brief",
  "body": "Reviewed research text with dated observations.",
  "citations": ["https://example.org/source-one", "https://example.org/source-two"],
  "preview": { "summary": "Research scope and sources", "relevance": 0.8, "sourceQuality": 0.9, "freshnessDays": 2 }
}
```

Replace the example text and URLs with reviewed material. Preview scores are seller claims; the buyer verifies the delivered bytes and citation URL fields, and the demo should describe the score as a selection rubric rather than an independent truth rating.

Build the backend, then run live setup with the seller URL. Supply the pinned deployment, owner-only Tatum key, Walrus endpoints, and buyer memory config described in the [backend guide](../backend/README.md). The first setup can omit `--workflow`; it creates five isolated homes and prints the **only address to fund**, the buyer address.

```sh
pnpm --dir backend build
node backend/dist/demo.js setup --state-dir .state/remote-demo-v2 \
  --seller-url https://supercuts-sellers-testnet.onrender.com \
  --deployment-config config/phase1.testnet.json \
  --tatum-key-file .secrets/tatum.key \
  --write-grpc https://fullnode.testnet.sui.io:443 \
  --tatum-grpc https://sui-testnet-grpc.gateway.tatum.io:443 \
  --walrus-publisher "$WALRUS_PUBLISHER_URL" \
  --walrus-aggregator "$WALRUS_AGGREGATOR_URL" \
  --memory-config-file .secrets/memory.json \
  --max-memory-distance 0.65 \
  --rapidsnark circuits/build/tools/rapidsnark-src/build_prover/src/prover
```

Use the printed buyer address with the Sui Testnet faucet, then confirm its balance. Do not fund any seller address. Keep `run.json`, role homes, report files, and the provisioning config mode `0600` or directories `0700`.

Generate manifests, the seller provisioning config, and the buyer mandate workflow from the prepared files:

```sh
node backend/dist/seller-catalog-generate.js \
  --run-json .state/remote-demo-v2/run.json \
  --seller-url https://supercuts-sellers-testnet.onrender.com \
  --brief-a .secrets/brief-a.json --brief-b .secrets/brief-b.json \
  --analysis-a .secrets/analysis-a.json --analysis-b .secrets/analysis-b.json \
  --brief-a-price 1000000 --brief-b-price 1200000 --analysis-price 2000000 \
  --output .secrets/seller-provision.json \
  --workflow-output .secrets/remote-workflow.json
```

Prices above are example MIST values; choose amounts within the funded buyer balance and the owner mandate. Run `setup` again with the same arguments plus `--workflow .secrets/remote-workflow.json` to bind the buyer mandate to these exact capabilities. The seller URL must stay the same because it is part of the signed manifest.

## Provision Supabase and Render

Run [seller-service.sql](../backend/sql/seller-service.sql) in the Supabase project. A write-enabled Supabase MCP connection can apply the migration, but the Render service still needs a server-only service-role key. Generate a 32-byte `SELLER_STATE_KEY` in base64url and store it with the Supabase URL and service-role key in the operator environment and Render secrets. Do not commit it or place it in an MCP config.

Provision the three live seller homes. This publishes their signed manifests to Walrus, verifies the publisher/aggregator roundtrip, and writes encrypted role-state snapshots and artifact bytes to Supabase:

```sh
node backend/dist/seller-provision.js .secrets/seller-provision.json
```

The seller provision command reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SELLER_STATE_KEY` from the environment. Its config file must be owner-only. Deploy the `supercuts-sellers-testnet` service from [render.yaml](../render.yaml). Set its secret variables: the same three Supabase values, `FACILITATOR_URL`, `FACILITATOR_SHARED_KEY`, and `CLAUDE_API_KEY`. Omit or empty `SELLER_ALLOWED_BUYERS` for self-service access by any cryptographically valid buyer; set it to a comma-separated address list for a private offering. Use the same facilitator shared key as the existing facilitator deployment. The service exposes `/health`, `/v1/catalog`, encrypted negotiation and agreement APIs, protected x402 resources, and safe event metadata.

Seed the saved owner privacy rule for the competitor-analysis capability before the Codex task:

Walrus Mainnet Memory needs the repository's 1536-dimensional embedding adapter. Start Ollama with `embeddinggemma`, set `EMBEDDING_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1` and `EMBEDDING_UPSTREAM_MODEL=embeddinggemma`, run `pnpm --dir circuits embedding:adapter`, and point the owner-only memory config to `http://127.0.0.1:8787/v1` with model `embeddinggemma-1536` before seeding or recalling.

The remote setup uses an owner-configured 0.65 recall distance limit. A live seeded rule was returned at about 0.58 with this adapter; the normal 0.35 limit excluded it. Supercuts still validates the returned memory's provenance and exact capability, seller, network, and asset scope before it affects settlement.

```sh
node backend/dist/demo.js seed-policy --state-dir .state/remote-demo-v2 \
  --workflow .secrets/remote-workflow.json
node backend/dist/demo.js doctor --state-dir .state/remote-demo-v2 \
  --seller-url https://supercuts-sellers-testnet.onrender.com
```

The saved rule requires shielded settlement. A public-rail answer from the buyer conversation cannot weaken it. The buyer may ask for a stricter rule, but changing the saved rule itself is an owner action.

## Record the buyer and seller panes

Use the buyer stanza from `.state/remote-demo-v2/buyer-codex.toml` in Codex's MCP config, or register the server with `codex mcp add` using its Node command, script path, `SUPERCUTS_HOME`, `SUPERCUTS_SELLER_URL`, `SUPERCUTS_RUN_ID`, and `SUPERCUTS_EVENT_PATH` values. The generated config points to the built local MCP script, so a global `supercuts-mcp` executable is not required. The buyer receives only buyer tools. Seller signing keys and Supabase credentials never enter Codex.

On the right, run `supercuts-seller-watch` in three panes, one for each seller address in `run.json`. Each pane shows the live Render service's safe activity for that identity. These are activity views of Claude-backed remote sellers, not separate local Codex sessions. For example, run this in the first pane and substitute `secondPublicSeller` and `confidentialSeller` in the other two:

```sh
node backend/dist/seller-watch.js \
  --seller-url https://supercuts-sellers-testnet.onrender.com \
  --run-id "$(jq -r .runId .state/remote-demo-v2/run.json)" \
  --seller-id "$(jq -r .addresses.publicSeller .state/remote-demo-v2/run.json)"
```

Give Codex this task:

> Find the best public Sui market brief within my total budget, buy it, then obtain the competitor analysis matching the delivered brief. Use my saved privacy preference when choosing how to pay. Give me both delivered artifacts, their hashes, the selection reason, and both Testnet transaction digests.

Codex should ask for a total budget in MIST and the Sui topic if missing. It should call `wallet.balance` and make a standard v2 deposit before negotiation, then call `remote.rank-briefs`, explain the visible score and total projected cost, and call `remote.purchase-brief` with the winning capability. After that it should write ten short, meaningful typed memories with `memory.remember`, call `memory.recall` for the saved privacy rule, then call `remote.agreement`, `remote.settle-analysis`, and `remote.delivery`. The analysis delivery may return `payment-pending` until the seller observes the finalized pool payment; retry the **same session and operation IDs**. The seller's signed encrypted negotiation transcript is published to Walrus; seller event panes show only hashes and blob IDs.

After the buyer records the analysis delivery, stop the buyer MCP process and the hosted seller service so neither can write an older snapshot or event sequence. In the owner environment, provide `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SELLER_STATE_KEY` as environment variables. Choose a future, owner-approved window in Unix milliseconds, then queue the standard 1,000,000 MIST exit using the analysis session ID returned by `remote.agreement`:

```sh
node backend/dist/hosted-exit-cli.js \
  --run-json .state/remote-demo-v2/run.json \
  --session-id SESSION_ID_FROM_AGREEMENT \
  --window-start WINDOW_START_MS \
  --window-end WINDOW_END_MS
```

The command restores only the confidential seller's encrypted Supabase snapshot in a temporary owner-only role home. It checks the matching delivered session and recovered payment note, prepares a standard v2 exit proof, persists the updated snapshot, and appends a safe `delayed-exit` event. It does not submit the withdrawal early or expose the seller signer, note opening, proof, or payout key in the event stream. Restart the hosted seller service after the command succeeds. Retry the same session if the command fails after persisting the snapshot; the exit operation is idempotent.

Finish by checking the event path printed by setup. The checker reads the hosted seller's encrypted snapshot using those same owner environment variables and verifies that the event names the prepared exit for the recovered note:

```sh
node backend/dist/demo.js check --state-dir .state/remote-demo-v2 \
  --events PATH_FROM_SETUP
```

The public x402 transaction exposes amount and payee. The shielded pool transfer does not expose a direct payment naming the analysis seller or amount; the buyer gas sender, funding, deposit, withdrawal, and pool activity remain visible. The pool is experimental Testnet software, not production custody. Render Free services can cold-start and have ephemeral local storage; Supabase snapshots preserve seller state after completed requests. Warm both Render services and check Supabase availability before recording.
