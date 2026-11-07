#!/usr/bin/env bash
set -uo pipefail
if [[ -n "${PG_TEST_URL:-}" ]]; then
  ajs module test . && pnpm run test:external:run
  exit
fi
log=$(mktemp)
trap 'rm -f "$log"' EXIT
pnpm run test:external:run >"$log" 2>&1 &
external=$!
ajs module test .
owned=$?
wait "$external"
status=$?
cat "$log"
exit $((owned || status))
