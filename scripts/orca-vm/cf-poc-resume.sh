#!/usr/bin/env bash
# Orca environmentRecipes resume: same wake path as create; pairingCode must be re-emitted.
set -euo pipefail
source "$(dirname "$0")/cf-poc-lib.sh"
cf_poc_env
# Lifecycle payload on stdin is optional (userData.resourceId is the shared DO name).
cat >/dev/null || true
cf_poc_start
cf_poc_recipe_json
