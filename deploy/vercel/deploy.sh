#!/usr/bin/env bash
# The front door on Vercel: thun-murex.duchpanhathun.com forwards every
# request, with the secret the public door checks, to the Latitude through
# Tailscale Funnel. Run on the Latitude, signed in with `vercel login`, after
# deploy/setup-door.sh. Then point the domain at Vercel with dns.sh.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
domain="${THUN_MUREX_DOMAIN:-thun-murex.duchpanhathun.com}"
project="${VERCEL_PROJECT:-thun-murex}"
secret="$(sed -n 's/^ORIGIN_SECRET=//p' "$here/../../.env" | tail -1)"
if [ "${#secret}" -lt 32 ]; then
  echo "There's no ORIGIN_SECRET in the gateway's .env yet: run deploy/setup-door.sh first." >&2
  exit 1
fi

cd "$here"
vercel project create "$project" >/dev/null 2>&1 || true # there already: fine
vercel link --yes --project "$project"
printf '%s' "$secret" | vercel env add ORIGIN_SECRET --environment production --sensitive --force --yes >/dev/null
vercel deploy --prod --yes
vercel domains add "$domain" "$project" || true # added before: fine
echo
echo "Deployed. Now point $domain at Vercel: deploy/vercel/dns.sh"
