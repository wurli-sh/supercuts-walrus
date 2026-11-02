#!/usr/bin/env bash
set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-$repository/.state/v2-package}"
if [[ -e "$output/Published.toml" ]]; then
  echo "refusing to overwrite an already published v2 package" >&2
  exit 1
fi
mkdir -p "$output/sources"
chmod 700 "$output"
cp "$repository/contracts/sources/pool_v2.move" "$output/sources/pool_v2.move"
cat > "$output/Move.toml" <<'TOML'
[package]
name = "supercuts_pool_v2"
edition = "2024"
license = "Apache-2.0"

[dependencies]

[addresses]
supercuts_pool = "0x0"
TOML
echo "$output"
