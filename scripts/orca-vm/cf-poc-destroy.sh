#!/usr/bin/env bash
# Orca environmentRecipes destroy: stop is idempotent; nothing else to tear down in v0.
set -euo pipefail
source "$(dirname "$0")/cf-poc-lib.sh"
cf_poc_env
cat >/dev/null || true
cf_poc_stop
