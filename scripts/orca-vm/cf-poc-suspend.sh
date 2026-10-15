#!/usr/bin/env bash
# Orca environmentRecipes suspend: stop the container (identity is harvested by the Worker).
set -euo pipefail
source "$(dirname "$0")/cf-poc-lib.sh"
cf_poc_env
cat >/dev/null || true
cf_poc_stop
