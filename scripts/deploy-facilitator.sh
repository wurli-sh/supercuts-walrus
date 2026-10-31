#!/usr/bin/env bash
set -euo pipefail
mode="${1:---dry-run}"
[[ "$mode" == "--dry-run" || "$mode" == "--deploy" ]] || { echo "usage: $0 [--dry-run|--deploy]" >&2; exit 2; }
git remote get-url origin | grep -Eq '(^|[:/])wurli-sh/supercuts-walrus(\.git)?$' || { echo "origin must be wurli-sh/supercuts-walrus" >&2; exit 1; }
command -v render >/dev/null || { echo "Render CLI is required (install it and run render login)" >&2; exit 1; }
render whoami >/dev/null || { echo "Render CLI is not authenticated" >&2; exit 1; }
[[ -n "${FACILITATOR_SHARED_KEY:-}" ]] || { echo "FACILITATOR_SHARED_KEY must be set locally for validation; it is never printed or uploaded by this script" >&2; exit 1; }
[[ ${#FACILITATOR_SHARED_KEY} -ge 24 ]] || { echo "FACILITATOR_SHARED_KEY must be at least 24 characters" >&2; exit 1; }
echo "service=supercuts-x402-facilitator-testnet region=singapore plan=free network=sui:testnet key=[REDACTED]"
service_id="$(render services --output json | node -e '
  let input = ""; process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
    const services = JSON.parse(input);
    const found = services.find((item) => item.service?.name === "supercuts-x402-facilitator-testnet");
    if (found) process.stdout.write(found.service.id);
  });
')"
if [[ "$mode" == "--dry-run" ]]; then
  [[ -n "$service_id" ]] && echo "existing_service=$service_id" || echo "service will be created from render.yaml settings"
  exit 0
fi
if [[ -z "$service_id" ]]; then
  # Render CLI does not expose Blueprint creation. This is the equivalent
  # non-interactive Docker service declaration; the existing secret is never
  # updated on subsequent runs.
  service_id="$(render services create --name supercuts-x402-facilitator-testnet --type web_service --repo https://github.com/wurli-sh/supercuts-walrus --branch main --root-directory backend --runtime docker --region singapore --plan free --health-check-path /health --env-var NODE_ENV=production --env-var SUI_TESTNET_GRPC=https://fullnode.testnet.sui.io:443 --env-var FACILITATOR_SHARED_KEY="$FACILITATOR_SHARED_KEY" --auto-deploy --confirm --output json | node -e 'let input="";process.stdin.on("data",(chunk)=>input+=chunk).on("end",()=>process.stdout.write(JSON.parse(input).id))')"
fi
render deploys create "$service_id" --commit "$(git rev-parse HEAD)" --wait --confirm
