#!/bin/sh
# Wrapper script for MCP server startup.
# Detects better-sqlite3 native module version mismatch and rebuilds
# using whichever Node binary is actually running this script.
#
# Claude Desktop (and other MCP clients) may launch this with a
# minimal PATH that doesn't include nvm or homebrew. We ensure
# common Node locations are on PATH so `node` and `npm` resolve.

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Ensure common Node/npm locations are on PATH
for p in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node"/*/bin; do
  case ":$PATH:" in
    *:"$p":*) ;;
    *) [ -d "$p" ] && PATH="$p:$PATH" ;;
  esac
done
export PATH

# Quick check: try to load better-sqlite3 with the current Node
if ! node -e "new (require('better-sqlite3'))(':memory:').close()" 2>/dev/null; then
  echo "better-sqlite3 needs rebuild for Node $(node -v)..." >&2
  npm rebuild better-sqlite3 >&2 2>&1
  echo "Rebuild complete." >&2
fi

exec node "$DIR/dist/index.js"
