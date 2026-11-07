#!/usr/bin/env bash
set -uo pipefail
if [[ -n "${PG_TEST_URL:-}" ]]; then
  ajs module test . && pnpm run test:external:run
  exit
fi
log=$(mktemp)
groups=()
stop() {
  trap '' INT TERM
  for group in "${groups[@]}"; do
    kill -TERM -- "-$group" 2>/dev/null
  done
  wait
  cat "$log"
  exit "$1"
}
trap 'rm -f "$log"' EXIT
trap 'stop 130' INT
trap 'stop 143' TERM
set -m
pnpm run test:external:run >"$log" 2>&1 &
external=$!
groups+=("$external")
ajs module test . &
owned=$!
groups+=("$owned")
set +m
wait "$owned"
owned_status=$?
wait "$external"
external_status=$?
trap - INT TERM
cat "$log"
exit $((owned_status || external_status))
