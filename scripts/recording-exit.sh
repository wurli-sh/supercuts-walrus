#!/usr/bin/env bash
# Finishes a recording run after both deals:
#   1. requires the buyer MCP to be closed (it and the exit both append to the event stream),
#   2. finds the run's confidential shielded payment and its seller in the event stream,
#   3. queues that seller's standard delayed exit (skipped if this run already queued it),
#   4. restarts the hosted seller so it reloads the updated snapshot, and
#   5. runs the read-only recording acceptance gate.
# Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SELLER_STATE_KEY in .env and a logged-in Render CLI.
# The seller's snapshot writes are revision-checked, so it cannot overwrite the queued exit.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/recording-lib.sh"
delay_min=10; window_hours=24
while (( $# )); do
  case "$1" in
    --start-in-minutes) delay_min="$2"; shift 2 ;;
    --window-hours) window_hours="$2"; shift 2 ;;
    *) echo "usage: scripts/recording-exit.sh [--start-in-minutes 10] [--window-hours 24]" >&2; exit 2 ;;
  esac
done
home="$(buyer_env SUPERCUTS_HOME)"; events="$(buyer_env SUPERCUTS_EVENT_PATH)"
[[ -n "$home" && -n "$events" ]] || { echo "supercuts-buyer SUPERCUTS_HOME or SUPERCUTS_EVENT_PATH is missing from $codex_config" >&2; exit 1; }
[[ -f "$events" ]] || { echo "event stream $events does not exist; run the deals first" >&2; exit 1; }
holder="$(lease_holder "$home" || true)"
if [[ -n "$holder" ]] || codex_running; then
  echo "Close Codex first: the buyer MCP${holder:+ (process $holder)} still appends to $events." >&2
  echo "Then stop its daemon: pkill -f 'codex app-server'${holder:+; kill $holder}" >&2
  exit 1
fi
node="$(supercuts_node)"

# The confidential deal: a completed shielded deal and the seller its memory-influenced plan chose.
deal="$(jq -rs '
  (map(select(.stage == "deal-lifecycle" and .publicDetails.rail == "shielded" and .publicDetails.state == "complete" and (.publicDetails.paymentDigest | type) == "string")) | first) as $deal
  | if $deal == null then empty else
      (map(select(.stage == "memory-influence" and .sequence < $deal.sequence and .publicDetails.withMemory.rail == "shielded")) | last) as $plan
      | "\($deal.publicDetails.paymentDigest) \($plan.publicDetails.withMemory.sellerId // "")"
    end' "$events")" || { echo "could not read $events" >&2; exit 1; }
read -r digest seller <<<"$deal" || true
[[ -n "${digest:-}" && -n "${seller:-}" ]] || { echo "no completed confidential (shielded) deal with a planned seller in $events" >&2; exit 1; }
echo "confidential payment $digest to seller $seller"

if jq -e --arg d "$digest" 'select(.stage == "delayed-exit" and .publicDetails.paymentDigest == $d and .publicDetails.state == "queued")' "$events" >/dev/null; then
  echo "delayed exit already queued for this payment"
else
  now_ms=$(( $(date +%s) * 1000 ))
  start=$(( now_ms + delay_min * 60000 )); end=$(( start + window_hours * 3600000 ))
  (cd "$repo" && "$node" --env-file=.env backend/dist/hosted-exit-cli.js --seller-id "$seller" --payment-digest "$digest" \
    --events "$events" --window-start "$start" --window-end "$end") | tail -1 | jq -c '{ok, error: .error.code, status: .data.status, operationId: .data.operationId, executeAt: .data.executeAt}' || true
  jq -e --arg d "$digest" 'select(.stage == "delayed-exit" and .publicDetails.paymentDigest == $d)' "$events" >/dev/null || { echo "exit was not queued" >&2; exit 1; }
fi

seller_url="https://supercuts-sellers-testnet.onrender.com"
service="$(render services -o json | jq -r '.[].service | select(.name == "supercuts-sellers-testnet") | .id' | head -1)"
[[ -n "$service" ]] || { echo "Render service supercuts-sellers-testnet not found; restart the hosted seller manually" >&2; exit 1; }
echo "restarting hosted seller $service to reload its snapshot"
render restart "$service" --confirm -o text >/dev/null
"$repo/scripts/warm-hosted.sh" "$seller_url" >/dev/null || { echo "seller did not come back; run scripts/warm-hosted.sh --redeploy" >&2; exit 1; }

cd "$repo" && "$node" --env-file=.env scripts/recording-check.mjs --buyer-home "$home" --events "$events" --seller-id "$seller" | tail -1 | jq .
