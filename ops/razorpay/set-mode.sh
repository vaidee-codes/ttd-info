#!/usr/bin/env bash
# Switches the TEST APP (Vercel project ttd-info-keygen) between Razorpay test and live mode.
# Run it yourself: it reads your Razorpay keys locally and never prints them.
#   ./set-mode.sh live    # real payments: needs ~/.razorpayenv (rzp_live_…) + ~/.razorpay-live-webhook-secret
#   ./set-mode.sh test    # back to sandbox: ~/.razorpay-test.env + ~/.razorpay-test-webhook-secret
set -euo pipefail
MODE="${1:-}"
case "$MODE" in live) KEYS="$HOME/.razorpayenv"; HOOK="$HOME/.razorpay-live-webhook-secret"; PREFIX="rzp_live_" ;;
                test) KEYS="$HOME/.razorpay-test.env"; HOOK="$HOME/.razorpay-test-webhook-secret"; PREFIX="rzp_test_" ;;
                *) echo "usage: $0 live|test" >&2; exit 2 ;; esac
cd "$(dirname "$0")/../.."
project=$(node -e 'try{console.log(require("./.vercel/project.json").projectName||"")}catch{console.log("")}')
[ "$project" = "ttd-info-keygen" ] || { echo "Refusing: linked to '${project:-nothing}', expected the test app 'ttd-info-keygen'." >&2; exit 1; }

value() { sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"?([^\"[:space:]]*)\"?.*/\1/p" "$KEYS" | head -1; }
KEY_ID="$(value api_key)"; KEY_SECRET="$(value api_secret)"
case "$KEY_ID" in "$PREFIX"*) ;; *) echo "The key in $KEYS is not a $MODE key (expected $PREFIX…)." >&2; exit 1 ;; esac
[ -n "$KEY_SECRET" ] && [ -s "$HOOK" ] || { echo "Missing api_secret in $KEYS or webhook secret file $HOOK." >&2; exit 1; }

if [ "$MODE" = live ]; then
  echo "This makes https://ttd-info-keygen.vercel.app/pass take REAL payments (₹99 / ₹299 / ₹699)."
  read -r -p "Type LIVE to continue: " answer
  [ "$answer" = "LIVE" ] || { echo "Cancelled."; exit 1; }
fi
put() {
  vercel env rm "$1" production -y >/dev/null 2>&1 || true
  printf '%s' "$2" | vercel env add "$1" production ${3:-} >/dev/null 2>&1 || { echo "FAILED to set $1 — mode NOT switched." >&2; exit 1; }
  echo "set $1"
}
put RAZORPAY_KEY_ID "$KEY_ID"
put RAZORPAY_KEY_SECRET "$KEY_SECRET" --sensitive
put RAZORPAY_WEBHOOK_SECRET "$(tr -d '[:space:]' < "$HOOK")" --sensitive
put RAZORPAY_MODE "$MODE"
if ! vercel deploy --prod --yes >/dev/null 2>&1; then
  echo "Deploy FAILED. The env vars are set to $MODE, but the running app still uses the previous mode." >&2
  echo "Fix the deploy and run: vercel deploy --prod --yes" >&2
  exit 1
fi
# Confirm the redeployed app answers.
url="https://ttd-info-keygen.vercel.app"
if ! curl -fsS -m 15 "$url/api/config" >/dev/null; then echo "Deployed, but $url/api/config did not answer — check it." >&2; exit 1; fi
echo "Test app is now in Razorpay $MODE mode."
