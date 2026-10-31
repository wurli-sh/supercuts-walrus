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
if [[ "$mode" == "--dry-run" ]]; then exit 0; fi
echo "Creating the Blueprint service if it is absent; existing Render secrets are left unchanged."
render blueprint apply --file render.yaml --confirm
render deploys create supercuts-x402-facilitator-testnet --commit "$(git rev-parse HEAD)" --wait
