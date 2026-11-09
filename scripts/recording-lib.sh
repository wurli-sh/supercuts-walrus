# Shared helpers for the recording scripts. Source it; do not run it.
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
codex_config="${CODEX_CONFIG:-$HOME/.codex/config.toml}"

# Reads KEY from [mcp_servers.supercuts-buyer.env] in the Codex config.
buyer_env() { # key
  awk -v key="$1" '
    /^\[/ { inside = ($0 == "[mcp_servers.supercuts-buyer.env]") ; next }
    inside && $0 ~ "^[ \t]*" key "[ \t]*=" { sub(/^[^=]*=[ \t]*"/, ""); sub(/"[ \t]*(#.*)?$/, ""); print; exit }
  ' "$codex_config"
}

# A Node new enough for node:sqlite: SUPERCUTS_NODE, then node on PATH, then the newest nvm install.
supercuts_node() {
  local candidate
  for candidate in "${SUPERCUTS_NODE:-}" "$(command -v node || true)" $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V -r); do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=13?0:1)'; then printf '%s\n' "$candidate"; return 0; fi
  done
  echo "no Node 22.13+ found; set SUPERCUTS_NODE" >&2; return 1
}

# Codex keeps MCP servers alive in its background daemon after the TUI exits.
codex_running() { pgrep -f 'codex app-server' >/dev/null; }

lease_holder() { # buyer-home: prints the live PID holding the buyer lease, if any
  local pid; pid="$(jq -r '.pid // empty' "$1/.mcp.lock" 2>/dev/null)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && printf '%s\n' "$pid"
}
