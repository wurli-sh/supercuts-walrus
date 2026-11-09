#!/usr/bin/env bash
# Wake the hosted seller and x402 facilitator before a live recording.
# Render free instances sleep after 15 idle minutes; a cold start can take a minute or more.
# Run this right before recording, not on a schedule: two always-on free services exceed
# the workspace's monthly free instance hours.
# Pass --redeploy to let a stalled service recover by itself: Render sometimes accepts requests
# for a sleeping free service without ever starting it, and only a fresh deploy wakes it.
# That needs the Render CLI logged in to the workspace that owns both services.
set -uo pipefail
redeploy=0
if [[ "${1:-}" == "--redeploy" ]]; then redeploy=1; shift; fi
seller="${1:-https://supercuts-sellers-testnet.onrender.com}"; seller="${seller%/}"
facilitator="${2:-https://supercuts-x402-facilitator-testnet.onrender.com}"; facilitator="${facilitator%/}"

wait_for() { # name url pattern
  local name="$1" url="$2" pattern="$3" body
  while (( SECONDS < deadline )); do
    if body="$(curl --silent --fail --max-time 90 "$url")" && [[ "$body" == *$pattern* ]]; then
      printf '%s is warm: %s\n' "$name" "$body"; return 0
    fi
    sleep 5
  done
  printf '%s did not wake within the deadline: %s\n' "$name" "$url" >&2
  printf 'A stalled wake-up needs a fresh deploy: rerun with --redeploy\n' >&2
  return 1
}

# Render names each service after its onrender.com subdomain.
redeploy_service() { # url
  local name; name="$(sed -E 's#^https?://([^.]+)\..*#\1#' <<<"$1")"
  local id; id="$(render services -o json 2>/dev/null | jq -r --arg n "$name" '.[].service | select(.name == $n) | .id' | head -1)"
  if [[ -z "$id" ]]; then printf 'no Render service named %s for this login\n' "$name" >&2; return 1; fi
  printf 'redeploying stalled %s (%s)\n' "$name" "$id"
  render deploys create "$id" --wait --confirm -o json >/dev/null || { printf 'redeploy of %s failed\n' "$name" >&2; return 1; }
}

warm_both() {
  deadline=$((SECONDS + ${WARM_TIMEOUT_SECONDS:-240}))
  seller_ok=0; facilitator_ok=0
  # Wake both in parallel; each cold start runs independently.
  wait_for "seller" "$seller/health" '"ok":true' & local seller_pid=$!
  wait_for "facilitator" "$facilitator/supported" '"exact"' & local facilitator_pid=$!
  wait "$seller_pid" && seller_ok=1
  wait "$facilitator_pid" && facilitator_ok=1
}

warm_both
if (( redeploy == 1 )) && (( seller_ok == 0 || facilitator_ok == 0 )); then
  command -v render >/dev/null && command -v jq >/dev/null || { echo "--redeploy needs the render CLI and jq" >&2; exit 1; }
  (( seller_ok == 0 )) && { redeploy_service "$seller" & }
  (( facilitator_ok == 0 )) && { redeploy_service "$facilitator" & }
  wait
  warm_both
fi
status=0
(( seller_ok == 1 && facilitator_ok == 1 )) || status=1

if (( status == 0 )); then
  active="$(curl --silent --max-time 30 "$seller/health" | grep -o '"active":[0-9]*' | cut -d: -f2)"
  if [[ "${active:-0}" == "0" ]]; then
    echo "seller is awake but serves no active v2 capabilities; renew expired registrations" >&2
    status=1
  fi
fi
exit "$status"
