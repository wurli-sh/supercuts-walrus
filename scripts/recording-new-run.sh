#!/usr/bin/env bash
# Prepares a clean recording run for the buyer configured in Codex:
#   1. refuses while Codex or a stale buyer MCP still runs (or stops them with --stop-codex),
#   2. points SUPERCUTS_RUN_ID and SUPERCUTS_EVENT_PATH at a new run (backing up the config),
#   3. checks the 1536-dimension embedding adapter, and
#   4. wakes the hosted seller and facilitator (--redeploy is passed through).
# It never runs a deal, moves funds, or changes the buyer's wallet, mandate, or memory.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/recording-lib.sh"
stop_codex=0; warm_args=()
for arg in "$@"; do
  case "$arg" in
    --stop-codex) stop_codex=1 ;;
    --redeploy) warm_args+=(--redeploy) ;;
    *) echo "usage: scripts/recording-new-run.sh [--stop-codex] [--redeploy]" >&2; exit 2 ;;
  esac
done
[[ -f "$codex_config" ]] || { echo "no Codex config at $codex_config" >&2; exit 1; }
home="$(buyer_env SUPERCUTS_HOME)"
[[ -n "$home" && -f "$home/profile.json" ]] || { echo "supercuts-buyer SUPERCUTS_HOME is missing from $codex_config" >&2; exit 1; }

holder="$(lease_holder "$home" || true)"
if codex_running || [[ -n "$holder" ]]; then
  if (( stop_codex == 0 )); then
    echo "Codex or this buyer's MCP${holder:+ (process $holder)} is still running and would keep the old run and the buyer lease." >&2
    echo "Quit Codex, then rerun with --stop-codex to stop its background daemon and that MCP." >&2
    exit 1
  fi
  # Only the Codex daemon and this buyer's lease holder; other roles' MCP servers are left alone.
  pkill -TERM -f 'codex app-server' || true
  [[ -n "$holder" ]] && kill -TERM "$holder" 2>/dev/null || true
  # The MCP drains in-flight Walrus Memory writes for up to 20 s before exiting.
  for _ in $(seq 1 30); do { codex_running || [[ -n "$(lease_holder "$home" || true)" ]]; } || break; sleep 1; done
  holder="$(lease_holder "$home" || true)"
  if codex_running || [[ -n "$holder" ]]; then echo "Codex${holder:+ or buyer MCP $holder} did not exit; stop it manually" >&2; exit 1; fi
fi

run_id="$(uuidgen | tr 'A-Z' 'a-z')"
events="$home/events-$run_id.jsonl"
cp -p "$codex_config" "$codex_config.bak-$(date +%s)"
awk -v run="$run_id" -v events="$events" '
  /^\[/ { inside = ($0 == "[mcp_servers.supercuts-buyer.env]") }
  inside && $0 ~ /^[ \t]*SUPERCUTS_RUN_ID[ \t]*=/ { print "SUPERCUTS_RUN_ID = \"" run "\""; seen_run = 1; next }
  inside && $0 ~ /^[ \t]*SUPERCUTS_EVENT_PATH[ \t]*=/ { print "SUPERCUTS_EVENT_PATH = \"" events "\""; seen_events = 1; next }
  { print }
  END { if (!seen_run || !seen_events) exit 3 }
' "$codex_config" > "$codex_config.tmp" || { rm -f "$codex_config.tmp"; echo "supercuts-buyer env needs SUPERCUTS_RUN_ID and SUPERCUTS_EVENT_PATH lines" >&2; exit 1; }
chmod --reference="$codex_config" "$codex_config.tmp"; mv "$codex_config.tmp" "$codex_config"

dims="$(curl -s --max-time 15 -X POST http://127.0.0.1:8787/v1/embeddings -H 'content-type: application/json' \
  -d '{"model":"embeddinggemma-1536","input":"recording probe"}' | jq -r '.data[0].embedding | length' 2>/dev/null || true)"
adapter="ready"
if [[ "$dims" != "1536" ]]; then
  adapter="NOT RUNNING: EMBEDDING_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1 EMBEDDING_UPSTREAM_MODEL=embeddinggemma pnpm --dir circuits embedding:adapter"
fi
warm=0; "$repo/scripts/warm-hosted.sh" "${warm_args[@]}" || warm=1

cat <<OUT

run id:     $run_id
events:     $events
buyer home: $home
embeddings: $adapter
hosted:     $([[ $warm == 0 ]] && echo warm || echo "NOT WARM (rerun with --redeploy)")

Start Codex in a fresh chat; status should report roleHomeLease "acquired" and this run id.
After both deals, close Codex and run: scripts/recording-exit.sh
OUT
[[ "$dims" == "1536" && $warm == 0 ]]
