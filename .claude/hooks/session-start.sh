#!/bin/bash
# SessionStart hook — install npm dependencies so `npm run build`, `npm run lint`
# and the pre-push protocol are ready immediately in Claude Code on the web.
#
# Idempotent: safe to run every session. `npm install` reuses the cached
# node_modules baked into the container image (we deliberately use `install`,
# not `ci`, so the cache is honoured). Synchronous by design so dependencies
# are guaranteed present before the agent loop starts — flip to async mode
# (see the session-start-hook skill) if faster startup is preferred.
set -euo pipefail

# Web/remote sessions only — never run installs on a local dev machine.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

npm install --no-audit --no-fund
