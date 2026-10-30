#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

required=(cargo node pnpm rg sui)
for tool in "${required[@]}"; do command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }; done

echo "[1/8] Rust protocol"
cargo test --workspace
echo "[2/8] Circuit semantics"
pnpm --dir circuits install --frozen-lockfile
pnpm --dir circuits test
echo "[3/8] Move pool"
sui move test --path contracts
echo "[4/8] Auditor-scoped Seal policy"
sui move test --path seal-policy
echo "[5/8] Phase 2 type safety and unit tests"
pnpm --dir backend install --frozen-lockfile
pnpm --dir backend check
pnpm --dir backend test
echo "[6/8] Phase 2 end-to-end gates"
pnpm --dir backend test:e2e
echo "[7/8] Dependency vulnerability gates"
pnpm --dir circuits audit --audit-level moderate
pnpm --dir backend audit --audit-level moderate
if cargo audit --version >/dev/null 2>&1; then cargo audit; else echo "cargo-audit not installed; Rust advisory gate skipped"; fi
echo "[8/8] Recorded live evidence"
test -f phase-2-report.md
rg -q "ALGz0PUlNCacN6-1xWYu_s6bG_IkbOQQMZTNWCbZ5iI" phase-2-report.md
rg -q "W0n8fL_Kx5DX8sS_LIL7UQOLBTYnl_tL4Xui25jjp28" phase-2-report.md
rg -q "Ehpv7zZnxou3kxcYZDhDsZRueyiwWzT39SxsKefkZQG2" phase-2-report.md
rg -q "GESuMYAZxdxh7eXvHWCNdsnJ3CoLSNodgjfx2h8VayLx" phase-2-report.md
echo "PHASE 2 IMPLEMENTATION AND LOCAL E2E GATES: PASS"
echo "PHASE 2 FORMAL EXIT GATE: PASS (pinned test-only deployment; see phase-2-report.md)"
