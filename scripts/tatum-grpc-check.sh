#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

command -v node >/dev/null || {
  echo "missing node; install it and rerun" >&2
  exit 1
}

set -a
source .env
set +a

: "${TATUM_API_KEY:?missing TATUM_API_KEY}"
: "${TATUM_SUI_GRPC_ENDPOINT:?missing TATUM_SUI_GRPC_ENDPOINT}"

node scripts/tatum-grpc-check.mjs
