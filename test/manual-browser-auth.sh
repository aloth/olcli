#!/usr/bin/env bash
# Manual test for `olcli auth --browser`. Run by a human, never in CI: it opens
# a real browser window at the login page of the instance and waits for you to
# sign in there. It uses a temporary HOME, so your real olcli config is not
# touched, and it prints only a masked cookie.
#
#   npm run build
#   test/manual-browser-auth.sh                         # www.overleaf.com
#   OVERLEAF_BASE_URL=https://latex.example.org test/manual-browser-auth.sh
#   OLCLI_BROWSER="/path/to/Google Chrome.app" test/manual-browser-auth.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
[ -f "$CLI" ] || { echo "Run npm run build first." >&2; exit 1; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/olcli-manual-browser-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export HOME="$SCRATCH" XDG_CONFIG_HOME="$SCRATCH/.config" APPDATA="$SCRATCH/AppData"
unset OVERLEAF_SESSION OVERLEAF_EMAIL OVERLEAF_PASSWORD

profiles_before=$(ls -d "${TMPDIR:-/tmp}"/olcli-browser-* 2>/dev/null | wc -l | tr -d ' ')

echo "1. A browser window opens at the login page. Sign in there (SSO, Google, ORCID, two-factor all fine)."
echo "   olcli never sees what you type."
status=0
node "$CLI" auth --browser || status=$?

echo
echo "2. Checks:"
node "$CLI" auth status
profiles_after=$(ls -d "${TMPDIR:-/tmp}"/olcli-browser-* 2>/dev/null | wc -l | tr -d ' ')
if [ "$profiles_after" -gt "$profiles_before" ]; then
  echo "FAIL: a temporary browser profile was left behind" >&2
  exit 1
fi
if pgrep -f "olcli-browser-" >/dev/null 2>&1; then
  echo "FAIL: a browser started by olcli is still running" >&2
  exit 1
fi
config=$(find "$SCRATCH" -name config.json | head -1)
if grep -qi password "$config"; then
  echo "FAIL: the config file mentions a password" >&2
  exit 1
fi
echo "Stored keys: $(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"))).join(", "))' "$config")"
echo "OK (auth exit status $status). Also try: run it again and press Ctrl-C while the window is open; then close the window instead of signing in."
