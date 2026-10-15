#!/usr/bin/env bash
# Orca environmentRecipes create: wake the shared POC container and emit recipe JSON.
set -euo pipefail
source "$(dirname "$0")/cf-poc-lib.sh"
cf_poc_env
cf_poc_start
cf_poc_recipe_json
