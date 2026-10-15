#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .secrets.local ]]; then echo 'Missing .secrets.local. Run setup-secrets.sh.' >&2; exit 1; fi
# shellcheck disable=SC1091
source .secrets.local
: "${POC_WORKER_URL:?Export POC_WORKER_URL=https://<your-worker-host>}"
url="${POC_WORKER_URL%/}"
case "${1:-}" in
  start)   curl -fsS --max-time 30 -X POST -H "Authorization: Bearer $CONTROL_TOKEN" "$url/api/start" ;;
  status)  curl -fsS --max-time 30 -H "Authorization: Bearer $CONTROL_TOKEN" "$url/api/status" ;;
  pairing) curl -fsS --max-time 30 -H "Authorization: Bearer $CONTROL_TOKEN" "$url/api/pairing" ;;
  stop)    curl -fsS --max-time 30 -X POST -H "Authorization: Bearer $CONTROL_TOKEN" "$url/api/stop" ;;
  *) echo 'Usage: ./scripts/poc.sh {start|status|pairing|stop}' >&2; exit 2 ;;
esac
printf '\n'
