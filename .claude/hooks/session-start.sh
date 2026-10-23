#!/bin/bash
# Cloud sessions only: install dependencies and build the bundle (dist/sql-wasm.wasm) that DMCR Web needs.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

npm install --no-audit --no-fund
node esbuild.js

# the e2e and walkthrough runs need a local PostgreSQL; skip quietly where there is none
if command -v pg_ctlcluster >/dev/null 2>&1; then
  pg_ctlcluster 16 main start 2>/dev/null || true
fi
