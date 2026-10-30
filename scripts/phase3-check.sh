#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

required=(node pnpm)
for tool in "${required[@]}"; do command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }; done

echo "[1/5] Frozen install"
pnpm --dir backend install --frozen-lockfile
echo "[2/5] Type safety and complete backend regression suite"
pnpm --dir backend check
pnpm --dir backend test
echo "[3/5] Phase 3 role-separated CLI and MCP E2E"
pnpm --dir backend test:phase3
echo "[4/5] Installable package build"
pnpm --dir backend build
pack_dir="$(mktemp -d)"
trap 'rm -rf "$pack_dir"' EXIT
pnpm --dir backend pack --pack-destination "$pack_dir" >/dev/null
package_file="$(find "$pack_dir" -maxdepth 1 -name '*.tgz' -print -quit)"
test -n "$package_file"
test -f backend/dist/cli.js
test -f backend/dist/mcp.js
install_dir="$pack_dir/install"
mkdir -p "$install_dir"
pnpm --dir "$install_dir" add --allow-build=blake-hash "$package_file" >/dev/null
installed_home="$pack_dir/installed-buyer"
"$install_dir/node_modules/.bin/supercuts" init --role buyer --mock --home "$installed_home" >/dev/null
"$install_dir/node_modules/.bin/supercuts" doctor --home "$installed_home" | rg -q '"healthy":true'
echo "[5/5] Evidence and secret hygiene"
test -f phase-3-report.md
if rg -n --hidden --glob '!node_modules/**' --glob '!*.lock' '(suiprivkey1|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)' backend/src backend/test phase-3-report.md; then
  echo "potential secret-bearing phrase found in Phase 3 public artifacts" >&2
  exit 1
fi
echo "PHASE 3 IMPLEMENTATION AND LOCAL E2E GATES: PASS"
echo "PHASE 3 FORMAL LIVE/PUBLICATION GATE: see phase-3-report.md"
