#!/usr/bin/env bash
# Builds Keygen Portal at a pinned commit for our Keygen CE instance and deploys it as a
# static site to its own Vercel project (ttd-keygen-portal-spike). Contains no secrets:
# operators sign in with their Keygen admin email/password in the browser.
#   ./build-and-deploy.sh            # build + deploy
#   ./build-and-deploy.sh --build    # build only
set -euo pipefail

PORTAL_COMMIT="d34789f26a03"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HERE/.build"
SECRETS="$HOME/.keygen-spike.env"

ACCOUNT_ID="${KEYGEN_ACCOUNT_ID:-$(grep '^KEYGEN_ACCOUNT_ID=' "$SECRETS" | cut -d= -f2-)}"
HOST="${KEYGEN_HOST:-$(grep '^KEYGEN_HOST=' "$SECRETS" | cut -d= -f2-)}"
[ -n "$ACCOUNT_ID" ] && [ -n "$HOST" ] || { echo "KEYGEN_ACCOUNT_ID / KEYGEN_HOST missing" >&2; exit 1; }

rm -rf "$WORK/src"
git clone -q https://github.com/keygen-sh/keygen-portal.git "$WORK/src"
git -C "$WORK/src" checkout -q "$PORTAL_COMMIT"

cat > "$WORK/src/.env.production.local" <<EOF
VITE_KEYGEN_ACCOUNT_ID=$ACCOUNT_ID
VITE_KEYGEN_EDITION=CE
VITE_KEYGEN_MODE=singleplayer
VITE_KEYGEN_HOST=$HOST
VITE_KEYGEN_VERSION=1.8
EOF

printf '%s\n' 'allowBuilds:' '  esbuild: true' "  '@tailwindcss/oxide': true" "  '@sentry/cli': false" '  sharp: false' '  workerd: false' \
  >> "$WORK/src/pnpm-workspace.yaml"
(cd "$WORK/src" && pnpm install --no-frozen-lockfile && pnpm build)

mkdir -p "$WORK/site"
rm -rf "$WORK/site/"*
cp -R "$WORK/src/dist/." "$WORK/site/"
cat > "$WORK/site/vercel.json" <<'EOF'
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }],
  "headers": [{ "source": "/(.*)", "headers": [
    { "key": "X-Frame-Options", "value": "DENY" },
    { "key": "Referrer-Policy", "value": "no-referrer" },
    { "key": "X-Robots-Tag", "value": "noindex, nofollow" }
  ] }]
}
EOF

[ "${1:-}" = "--build" ] && { echo "Built into $WORK/site"; exit 0; }
cd "$WORK/site"
vercel link --yes --project ttd-keygen-portal-spike >/dev/null
vercel deploy --prod --yes
