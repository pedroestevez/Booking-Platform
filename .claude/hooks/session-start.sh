#!/bin/bash
set -euo pipefail

# Booking Platform — SessionStart hook (Claude Code on the web).
# Installs Node dependencies so dev / build / lint / typecheck work immediately.
# Runs synchronously: the session starts only after deps are ready, which avoids
# the agent racing ahead of an unfinished install.

# Only needed in remote (web) sessions; local dev manages its own dependencies.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# `npm install` (not `npm ci`) so the cached container layer is reused across sessions.
npm install --no-audit --no-fund
