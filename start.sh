#!/bin/sh
# Dev-tree launcher for the MCP server (see bootstrap.mjs for the node-only
# variant). Resolves the pinned Node via fnm first, then common locations,
# verifies the better-sqlite3 binding loads, and starts the server.
#
# It deliberately does NOT auto-rebuild on a mismatch: a launcher silently
# rebuilding node_modules under an unexpected runtime raced development
# rebuilds and corrupted the shared binary (macOS then killed every loader
# with Code Signature Invalid). The installed server lives in its own
# directory (~/.eve-sde/server via `npm run deploy`) — see README "Server
# install". On mismatch this fails loudly with the fix, it never mutates
# node_modules.

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Ensure common Node/npm locations are on PATH. fnm's version dirs go LAST
# in this loop so they end up FIRST in PATH — the dev tree's Node (pinned in
# .node-version) should win over system-wide installs like Homebrew's.
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.local/share/fnm/node-versions"/*/installation/bin; do
  case ":$PATH:" in
    *:"$p":*) ;;
    *) [ -d "$p" ] && PATH="$p:$PATH" ;;
  esac
done
export PATH

# Fail loudly if the binding doesn't load under the resolved runtime.
if ! node -e "new (require('better-sqlite3'))(':memory:').close()" 2>/dev/null; then
  echo "FATAL: better-sqlite3 binding does not load under Node $(node -v)." >&2
  echo "" >&2
  echo "This checkout's node_modules was built for a different Node version" >&2
  echo "(likely $(cat "$DIR/.node-version" 2>/dev/null || echo '?') per .node-version). Fix explicitly:" >&2
  echo "" >&2
  echo "  fnm use $(cat "$DIR/.node-version" 2>/dev/null || echo 22)" >&2
  echo "  npm run rebuild" >&2
  echo "" >&2
  echo "For the installed server (separate from this tree), launch" >&2
  echo "~/.eve-sde/server/start.sh instead — see README 'Server install'." >&2
  exit 1
fi

exec node "$DIR/dist/index.js"
