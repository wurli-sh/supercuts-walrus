#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

pnpm --dir backend install --frozen-lockfile
pnpm --dir backend check
pnpm --dir backend build
pnpm --dir backend --filter @supercuts/sdk check
pnpm --dir backend --filter @supercuts/sdk test
pnpm --dir backend --filter @supercuts/sdk build

pack_dir="$(mktemp -d)"
trap 'rm -rf "$pack_dir"' EXIT
pnpm --dir backend pack --pack-destination "$pack_dir" >/dev/null
pnpm --dir backend --filter @supercuts/sdk pack --pack-destination "$pack_dir" >/dev/null
backend_package="$(find "$pack_dir" -maxdepth 1 -name 'supercuts-backend-*.tgz' -print -quit)"
sdk_package="$(find "$pack_dir" -maxdepth 1 -name 'supercuts-sdk-*.tgz' -print -quit)"
test -n "$backend_package"
test -n "$sdk_package"
install_dir="$pack_dir/install"
mkdir -p "$install_dir"
pnpm --dir "$install_dir" add --allow-build=blake-hash "$backend_package" >/dev/null
pnpm --dir "$install_dir" add --allow-build=blake-hash "$sdk_package" >/dev/null
installed_home="$pack_dir/installed-buyer"
(cd "$install_dir" && SDK_HOME="$installed_home" node --input-type=module -e '
  import { BuyerClient, initializeProfile } from "@supercuts/sdk";
  await initializeProfile({ home: process.env.SDK_HOME }, { role: "buyer", mock: true });
  const buyer = await BuyerClient.connect({ home: process.env.SDK_HOME, approvalProvider: { async approve() { return { approved: true }; } } });
  const receipt = await buyer.deposit(3n);
  if (receipt.amount !== 3n || receipt.evidence !== "deterministic-mock-not-funded") process.exit(1);
')
echo "SUPERCUTS TYPESCRIPT SDK GATE: PASS"
