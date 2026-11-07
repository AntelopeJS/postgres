#!/usr/bin/env bash
set -uo pipefail
if [[ -n "${PG_TEST_URL:-}" ]]; then
  ajs module test . && pnpm run test:external:run
  exit
fi
log=$(mktemp)
trap 'rm -f "$log"' EXIT
set -m
pnpm run test:external:run >"$log" 2>&1 &
external=$!
ajs module test . &
owned=$!
set +m
trap 'kill -TERM -- "-$owned" "-$external" 2>/dev/null; exit 130' INT
trap 'kill -TERM -- "-$owned" "-$external" 2>/dev/null; exit 143' TERM
wait "$owned"
owned_status=$?
wait "$external"
external_status=$?
cat "$log"
exit $((owned_status || external_status))
