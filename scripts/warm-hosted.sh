#!/usr/bin/env bash
# Wake the hosted seller and x402 facilitator before a live recording.
# Render free instances sleep after 15 idle minutes; a cold start can take a minute or more.
# Run this right before recording, not on a schedule: two always-on free services exceed
# the workspace's monthly free instance hours.
set -uo pipefail
seller="${1:-https://supercuts-sellers-testnet.onrender.com}"; seller="${seller%/}"
facilitator="${2:-https://supercuts-x402-facilitator-testnet.onrender.com}"; facilitator="${facilitator%/}"
deadline=$((SECONDS + ${WARM_TIMEOUT_SECONDS:-240}))

wait_for() { # name url pattern
  local name="$1" url="$2" pattern="$3" body
  while (( SECONDS < deadline )); do
    if body="$(curl --silent --fail --max-time 90 "$url")" && [[ "$body" == *$pattern* ]]; then
      printf '%s is warm: %s\n' "$name" "$body"; return 0
    fi
    sleep 5
  done
  printf '%s did not wake within the deadline: %s\n' "$name" "$url" >&2
  printf 'A stalled wake-up needs a fresh deploy: render deploys create <service-id>\n' >&2
  return 1
}

# Wake both in parallel; each cold start runs independently.
wait_for "seller" "$seller/health" '"ok":true' & seller_pid=$!
wait_for "facilitator" "$facilitator/supported" '"exact"' & facilitator_pid=$!
status=0
wait "$seller_pid" || status=1
wait "$facilitator_pid" || status=1

if (( status == 0 )); then
  active="$(curl --silent --max-time 30 "$seller/health" | grep -o '"active":[0-9]*' | cut -d: -f2)"
  if [[ "${active:-0}" == "0" ]]; then
    echo "seller is awake but serves no active v2 capabilities; renew expired registrations" >&2
    status=1
  fi
fi
exit "$status"
