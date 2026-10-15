#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v openssl >/dev/null || ! command -v npx >/dev/null; then
  echo 'Need openssl and npx' >&2; exit 1
fi
if [[ "${1:-}" != '--confirm' ]]; then
  echo 'Creates Cloudflare Worker secrets and a local .secrets.local (chmod 600) file.' >&2
  echo 'Run: ./scripts/setup-secrets.sh --confirm' >&2
  exit 2
fi
if [[ -e .secrets.local ]]; then
  echo '.secrets.local already exists. Refusing to rotate secrets silently.' >&2
  exit 1
fi
umask 077
control_token="$(openssl rand -hex 32)"
connect_token="$(openssl rand -hex 32)"
printf 'CONTROL_TOKEN=%s\nCONNECT_TOKEN=%s\n' "$control_token" "$connect_token" > .secrets.local
chmod 600 .secrets.local
printf '%s' "$control_token" | npx wrangler secret put CONTROL_TOKEN
printf '%s' "$connect_token" | npx wrangler secret put CONNECT_TOKEN
printf 'Secrets are saved in .secrets.local (gitignored). Do not upload or share it.\n' >&2
