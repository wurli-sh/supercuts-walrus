#!/usr/bin/env bash
set -euo pipefail
url="${1:?usage: warm-facilitator.sh https://facilitator.example}"
url="${url%/}"
for attempt in $(seq 1 30); do
  if health="$(curl --silent --show-error --fail --max-time 15 "$url/health")" && supported="$(curl --silent --show-error --fail --max-time 15 "$url/supported")"; then
    case "$health:$supported" in *'"sui:testnet"'*'"exact"'*) printf '%s\n' 'Facilitator is warm and pinned to Sui Testnet.'; exit 0;; esac
  fi
  sleep 4
done
echo "Facilitator did not become ready: $url" >&2
exit 1
