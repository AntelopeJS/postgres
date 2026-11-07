#!/usr/bin/env bash
set -uo pipefail
if [[ -n "${PG_TEST_URL:-}" ]]; then
  ajs module test . && pnpm run test:external:run
  exit
fi
log=$(mktemp)
stop() {
  trap '' INT TERM HUP
  for job in $(jobs -p); do
    kill -TERM -- "-$job" 2>/dev/null
  done
  wait
  cat "$log" 2>/dev/null
  exit "$1"
}
trap 'rm -f "$log"' EXIT
trap 'stop 130' INT
trap 'stop 143' TERM
trap 'stop 129' HUP
set -m
pnpm run test:external:run >"$log" 2>&1 &
external=$!
ajs module test . &
owned=$!
set +m
wait "$owned"
owned_status=$?
wait "$external"
external_status=$?
trap - INT TERM HUP
cat "$log"
exit $((owned_status || external_status))
