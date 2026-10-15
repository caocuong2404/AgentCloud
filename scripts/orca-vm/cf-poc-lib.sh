#!/usr/bin/env bash
# Shared helpers for cf-poc lifecycle scripts. Progress on stderr; JSON only on stdout.
set -euo pipefail

cf_poc_env() {
  if [[ -z "${POC_WORKER_URL:-}" || -z "${CONTROL_TOKEN:-}" ]]; then
    local secrets
    secrets="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.secrets.local"
    # shellcheck disable=SC1090
    [[ -f "$secrets" ]] && source "$secrets"
  fi
  : "${POC_WORKER_URL:?Export POC_WORKER_URL or provide .secrets.local}"
  : "${CONTROL_TOKEN:?Export CONTROL_TOKEN or provide .secrets.local}"
  POC_WORKER_URL="${POC_WORKER_URL%/}"
}

cf_poc_start() {
  local start_out
  # Surface start failures (budget_guard 429, already_running 409) instead of masking.
  if ! start_out="$(curl -fsS --max-time 30 -X POST \
    -H "Authorization: Bearer $CONTROL_TOKEN" \
    "$POC_WORKER_URL/api/start" 2>&1)"; then
    echo "cf-poc: start request failed: $start_out" >&2
    case "$start_out" in
      *already_running*|*409*) ;; # fine; poll until ready
      *) return 1 ;;
    esac
  fi
  local i state
  for i in $(seq 1 40); do
    # Transient curl blips must not abort the poll loop under `set -e`.
    state="$(curl -fsS --max-time 15 -H "Authorization: Bearer $CONTROL_TOKEN" \
      "$POC_WORKER_URL/api/status" 2>/dev/null | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' || true)"
    echo "cf-poc: state=${state:-unknown} (${i}/40)" >&2
    [[ "$state" == "ready" ]] && return 0
    [[ "$state" == "stopped" ]] && { echo "cf-poc: container stopped unexpectedly" >&2; return 1; }
    sleep 3
  done
  echo "cf-poc: timed out waiting for ready" >&2
  return 1
}

cf_poc_stop() {
  curl -fsS --max-time 30 -X POST \
    -H "Authorization: Bearer $CONTROL_TOKEN" \
    "$POC_WORKER_URL/api/stop" >&2 || true
}

# Emit the Orca-server recipe JSON (skill §8). pairingCode is the runtime-scope URL.
# Pairing URL goes to python3 on stdin (not argv) so it never appears in `ps`.
cf_poc_recipe_json() {
  local pairing
  pairing="$(curl -fsS --max-time 30 -H "Authorization: Bearer $CONTROL_TOKEN" \
    "$POC_WORKER_URL/api/pairing")"
  local code
  code="$(printf '%s\n' "$pairing" | sed -n 's/^runtime pairing URL: //p' | head -1)"
  [[ -n "$code" ]] || { echo "cf-poc: no runtime pairing URL in /api/pairing" >&2; return 1; }
  printf '%s' "$code" | python3 -c 'import json,sys; print(json.dumps({"schemaVersion":1,"pairingCode":sys.stdin.read().strip(),"projectRoot":"/workspace","userData":{"resourceId":"poc-single-workspace"}}))'
}
