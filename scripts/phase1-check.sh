#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

required=(cargo node pnpm circom sui)
for tool in "${required[@]}"; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

echo "[1/5] Rust protocol vectors"
cargo test --workspace

echo "[2/5] Circuit dependency lock"
pnpm --dir circuits install --frozen-lockfile

echo "[3/5] Circuit compilation and vectors"
pnpm --dir circuits compile
pnpm --dir circuits test

echo "[4/5] Move build, statement tests, and BN254 probe"
sui move test --path contracts --statistics

echo "[5/5] Live-gate preflight"
active_env="$(sui client active-env 2>/dev/null || true)"
active_address="$(sui client active-address 2>/dev/null || true)"
echo "Sui environment: ${active_env:-unconfigured}"
echo "Sui address: ${active_address:-unconfigured}"

has_any() {
  local variable
  for variable in "$@"; do
    [[ -n "${!variable:-}" ]] && return 0
  done
  return 1
}

missing=()
has_any TATUM_API_KEY || missing+=("TATUM_API_KEY")
has_any WALRUS_MEMORY_ENDPOINT MEMWAL_SERVER_URL || missing+=("WALRUS_MEMORY_ENDPOINT|MEMWAL_SERVER_URL")
has_any WALRUS_MEMORY_DELEGATE_KEY MEMWAL_KEY || missing+=("WALRUS_MEMORY_DELEGATE_KEY|MEMWAL_KEY")
has_any WALRUS_MEMORY_ACCOUNT_ID MEMWAL_ACCOUNT_ID || missing+=("WALRUS_MEMORY_ACCOUNT_ID|MEMWAL_ACCOUNT_ID")
has_any EMBEDDING_ENDPOINT OPENAI_BASE_URL || missing+=("EMBEDDING_ENDPOINT|OPENAI_BASE_URL")
has_any X402_FACILITATOR_URL || missing+=("X402_FACILITATOR_URL")

if ((${#missing[@]})); then
  echo "LIVE GATE BLOCKED: missing operator variables: ${missing[*]}"
else
  echo "Live credential preflight passed; recorded transaction/blob evidence is in phase-1-report.md."
fi

echo "LOCAL RESULT: PASS"
echo "PHASE 1 EXIT GATE: PASSED FOR TEST-ONLY TESTNET DEPLOYMENT (see phase-1-report.md)"

