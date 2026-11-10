# Remote marketplace walkthrough with a Codex buyer

This walkthrough shows the Supercuts core flow end to end: agents negotiate privately,
settle on the public or shielded rail, and use Walrus Memory to carry an owner
privacy rule into the next payment decision. The memory recall must select the
shielded rail for the confidential analysis.

This path runs a buyer-only `supercuts-mcp` process in Codex. One Render web service hosts three separate seller identities: two prepared Sui market briefs and one competitor analysis with a prepared variant for each brief. The existing x402 facilitator remains a separate Render service. All payments use live Sui Testnet. Claude performs source-backed research before provisioning; the live payment service deterministically serves the reviewed, hash-bound artifact without depending on a model call.

The hosted seller path queues the confidential seller's standard delayed exit through a separate owner command after artifact delivery. Use an unused state directory for fresh v2 role homes; the examples below use `.state/remote-demo-v2`. Rerunning setup in the older `.state/remote-demo` directory does not upgrade its v1 profiles or notes.

## Prepare the reports and roles

Use four owner-only JSON report files in the ignored `.secrets/` directory: two public briefs and two matching competitor analyses. Draft files are provided there for review. Each brief needs `title`, `body`, at least two HTTPS `citations`, and a `preview` object with `summary`, `relevance` and `sourceQuality` in `[0,1]`, and `freshnessDays` in `[0,365]`. Each analysis needs `title` and `body`. Review the claims and sources before recording, then change `reviewStatus` from `draft-needs-owner-review` in each approved file. The analysis files must stay private; the catalog generator records their hashes but does not publish their plaintext.

Generate fresh drafts with Claude Haiku and Anthropic web search instead of hand-writing them. The command searches up to eight times, requires at least three unique citations observed in the search response, prefers primary and dated sources, writes mode `0600`, and never publishes the result:

```sh
export CLAUDE_API_KEY=...
supercuts seller research --kind market-brief \
  --topic "Current Sui market structure, adoption, and execution risks" \
  --output .secrets/brief-a.json

supercuts seller research --kind competitor-analysis \
  --topic "Competing projects and counterarguments to the purchased Sui brief" \
  --context-file .secrets/brief-a.json \
  --output .secrets/analysis-a.json
```

Use `--allowed-domains sui.io,docs.sui.io,github.com` when the offering requires a strict source allowlist. Review the generated claims and open every citation. Change `reviewStatus` to `approved` only after that review; provisioning rejects unapproved drafts. Repeat for the second brief and its matching analysis.

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

The seller provision command reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SELLER_STATE_KEY` from the environment. Its config file must be owner-only. Deploy the `supercuts-sellers-testnet` service from [render.yaml](../render.yaml). Set its secret variables: the same three Supabase values, `FACILITATOR_URL`, and `FACILITATOR_SHARED_KEY`. The Anthropic key stays in the owner research environment and is not needed by the buyer-facing service. Omit or empty `SELLER_ALLOWED_BUYERS` for self-service access by any cryptographically valid buyer; set it to a comma-separated address list for a private offering. Use the same facilitator shared key as the existing facilitator deployment. The service exposes `/health`, `/v1/catalog`, encrypted negotiation and agreement APIs, protected x402 resources, and safe event metadata.

Walrus Mainnet Memory needs the repository's 1536-dimensional embedding adapter. Start Ollama with `embeddinggemma`, set `EMBEDDING_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1` and `EMBEDDING_UPSTREAM_MODEL=embeddinggemma`, run `pnpm --dir circuits embedding:adapter`, and point the owner-only memory config to `http://127.0.0.1:8787/v1` with model `embeddinggemma-1536` before seeding or recalling.

The remote setup uses an owner-configured 0.65 recall distance limit. A live seeded rule was returned at about 0.58 with this adapter; the normal 0.35 limit excluded it. Supercuts still validates the returned memory's provenance and exact capability, seller, network, and asset scope before it affects settlement.

For these five-role homes, seed the owner privacy rule for the competitor-analysis capability and check the roles:

```sh
node backend/dist/demo.js seed-policy --state-dir .state/remote-demo-v2 \
  --workflow .secrets/remote-workflow.json
node backend/dist/demo.js doctor --state-dir .state/remote-demo-v2 \
  --seller-url https://supercuts-sellers-testnet.onrender.com
```

The saved rule requires shielded settlement. A public-rail answer from the buyer conversation cannot weaken it. The buyer may ask for a stricter rule, but changing the saved rule itself is an owner action.

## Record through the current deal tools

The report provisioning steps above describe the original hosted catalog. The
recording uses the current v2 buyer configuration from
[self-service setup](self-service-setup.md), with `deal-sellers.json` and an
active `supercuts.mandate.v2` authorizing `deal.execute`. The five-role demo
bootstrap alone does not create that standing mandate. Use `supercuts setup
renew --home <buyer-home> --config <owner-only-setup.json>` to configure it
without replacing the buyer signer or moving existing notes. Keep v1 homes
separate.

Save the owner privacy rule for the confidential capability class once:

```sh
supercuts policy add --home <buyer-home> --capability-class sui.confidential-analysis
```

A class rule covers every approved seller offering that class, so it still
applies when a seller re-registers under a new capability ID. A rule saved with
`--capability-id` binds one signed offer and lapses when that seller rotates
its capability; a deal then stops before payment rather than paying on x402.

Use the buyer's generated `buyer-codex.toml` in Codex. Point its executable at
the current built backend and set `tool_timeout_sec = 900` in the server table.
Only one buyer MCP process may own that home; a competing connection exposes
only `status`, reports `roleHomeLease: "busy"`, and names the process holding
it. Codex keeps MCP servers alive in its background `codex app-server` daemon
after the TUI exits, so quitting Codex alone does not release the home. Seller
credentials stay outside the buyer MCP config.

Check the buyer's native Testnet SUI balance, remaining mandate budget, and
pool balance with `supercuts onboarding doctor --home <buyer-home>`. Prefund
through a standard v2 deposit before any negotiation. Do not repeat an existing
deposit or payment merely to repair a missing memory.

### Start a clean run

Quit Codex, then:

```sh
pnpm --dir backend build
scripts/recording-new-run.sh --stop-codex
```

The script stops the Codex daemon and any stale buyer MCP, points
`SUPERCUTS_RUN_ID` and `SUPERCUTS_EVENT_PATH` in `~/.codex/config.toml` at a new
run (backing up the config), checks the 1536-dimensional embedding adapter, and
wakes the hosted seller and facilitator. Add `--redeploy` when Render accepts
requests but never starts a sleeping service; that triggers a fresh deploy of
the stalled service through the Render CLI. Start the recording within about
15 minutes, before the free services sleep again.

Open a fresh Codex chat. Asking it to check the Supercuts status should report
`roleHomeLease: "acquired"` and the new run ID. Deals read from an earlier run
are not added to this run's evidence.

### Record the deals

Ask the way an owner would; the deal tools describe themselves, so the prompt
does not name them. Confidential deal first:

> I need a confidential competitor analysis of DeepBook against the other Sui
> liquidity venues. Find a trusted seller and get it for me. Just pay with
> x402, it's quicker. When it's done, show me the analysis, how you paid, and
> why.

Codex reads the standing policy and signed catalog and runs the deal through
`deal.execute`. The plan must cite the owner privacy blob, report
`changedRail: true`, and include `MEMORY_PRIVACY_OVERRODE_RAIL`. Payment
finality, encrypted transcript readback, and delivery are verified before the
artifact is released.

Then the public deal:

> Now get me a Sui market brief. Nothing sensitive, so paying publicly with
> x402 is fine. Pick the best seller based on how past deals went, and stay
> within my budget. Show me the brief, the payment transaction, and why you
> chose that seller.

Describe a seller switch only if `memoryInfluence.changedSeller` is true.
Resume a stalled deal with `deal.resume` and the same operation ID. If outcome
memory is unresolved, use `deal.reconcile` with that operation ID; do not replay
payment or reset an ambiguous memory job. Keep Codex open for a minute or two
after the second deal so its memory worker indexes both outcomes. A completed
payment with unresolved outcome memory is not a passed recording check.

The reports are prepared, reviewed artifacts. Do not describe them as new
model research performed during settlement. Avoid recording raw Codex JSONL
logs, owner environment files, decrypted memory, signatures, or note material.
Use only the redacted demo event stream for evidence overlays.

### Queue the seller exit and check the run

Quit Codex and stop its daemon (`pkill -f 'codex app-server'`), then:

```sh
scripts/recording-exit.sh
```

It finds the run's confidential shielded payment and seller in the event
stream, queues that seller's standard delayed exit with a window opening in 10
minutes and lasting 24 hours (`--start-in-minutes`, `--window-hours`),
restarts the hosted seller so it reloads the updated snapshot, and runs the
acceptance gate. It needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`SELLER_STATE_KEY` in `.env` and a logged-in Render CLI. The seller's snapshot
writes are revision-checked, so a running seller cannot overwrite the queued
exit; it only needs the restart to load it. Show the exit as queued; this does
not demonstrate a completed withdrawal.

The underlying commands, for a manual run:

```sh
node --env-file=.env backend/dist/hosted-exit-cli.js \
  --seller-id "$CONFIDENTIAL_SELLER_ID" \
  --payment-digest "$SHIELDED_PAYMENT_DIGEST" \
  --events "$EVENT_PATH" \
  --window-start "$WINDOW_START_MS" --window-end "$WINDOW_END_MS"
node --env-file=.env scripts/recording-check.mjs \
  --buyer-home "$BUYER_HOME" --events "$EVENT_PATH" \
  --seller-id "$CONFIDENTIAL_SELLER_ID"
```

For a self-hosted seller, replace `--seller-id` with `--seller-home`. The gate
runs the current doctor and evidence checker, checks local embeddings and the
Testnet facilitator, and exits nonzero unless all checks pass. It does not run
a deal, request faucet funds, or queue an exit. A missing exit, unresolved
outcome memory, or unreachable dependency must remain a failed check.

The voiceover and recording cues live in the local `demo/` kit, which is
ignored by Git. Export the latest narration with
`python3 demo/generate_voiceover.py --script-only`. Verify each spoken event
against the recorded evidence before publishing.

Public x402 exposes amount and payee. Shielded settlement avoids a direct
payment naming the analysis seller and amount; the gas sender, funding,
deposits, withdrawals, and pool activity remain visible. The pool is experimental
Testnet software. Mainnet-backed Walrus Memory does not make the payment rail
Mainnet. `scripts/recording-new-run.sh` wakes the hosted services; if a
recording starts late, run `scripts/warm-hosted.sh` again just before it. Do not
keep the free Render services awake on a schedule.
