#!/usr/bin/env bash
# Fork learning wrapper: default -nc (no AGENTS.md / CLAUDE.md auto-load).
# Opt in to project context: ./scripts/pi-learn.sh --with-context ...
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_CONTEXT=false
ARGS=()

for arg in "$@"; do
  if [[ "$arg" == "--with-context" ]]; then
    WITH_CONTEXT=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$WITH_CONTEXT" == "true" ]]; then
  exec "$ROOT/pi-test.sh" ${ARGS[@]+"${ARGS[@]}"}
fi

exec "$ROOT/pi-test.sh" -nc ${ARGS[@]+"${ARGS[@]}"}