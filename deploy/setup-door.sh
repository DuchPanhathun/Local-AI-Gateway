#!/usr/bin/env bash
# Sets up the public door on the Latitude: a secret for Vercel to send (kept
# in the gateway's .env as ORIGIN_SECRET, made once), and the door's user
# service on 127.0.0.1:3001. It stays closed to the internet until Tailscale
# Funnel points at it:
#   tailscale funnel --bg --https=10000 http://127.0.0.1:3001
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$here/../.env"

if ! grep -q '^ORIGIN_SECRET=.\{32,\}' "$env_file" 2>/dev/null; then
  printf '\n# The secret Vercel adds to every request it forwards to the public door.\nORIGIN_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$env_file"
  echo "Made ORIGIN_SECRET in $env_file"
fi

mkdir -p ~/.config/systemd/user
cp "$here/thun-murex-door.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable -q thun-murex-door
systemctl --user restart thun-murex-door
sleep 1
systemctl --user is-active -q thun-murex-door || { journalctl --user -u thun-murex-door -n 20 --no-pager; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/)
[ "$code" = 403 ] || { echo "The door should refuse a request without the secret, but answered $code" >&2; exit 1; }
echo "The door is running on 127.0.0.1:3001, and refuses requests without the secret."
