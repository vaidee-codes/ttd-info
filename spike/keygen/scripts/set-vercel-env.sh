#!/usr/bin/env bash
# Run this yourself. It reads ~/.dbpassword locally, generates Keygen secrets into
# ~/.keygen-spike.env (chmod 600) and pushes everything to the SPIKE Vercel project only.
#
#   ./set-vercel-env.sh --pooler-uri 'postgresql://postgres.<ref>:[YOUR-PASSWORD]@<host>:5432/postgres' \
#                       --admin-email you@example.com
#   ./set-vercel-env.sh --finish-bootstrap     # after the first successful boot
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HERE/../vercel"
SECRETS="$HOME/.keygen-spike.env"
EXPECTED_PROJECT="ttd-keygen-spike"

POOLER_URI=""; ADMIN_EMAIL=""; FINISH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pooler-uri) POOLER_URI="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --finish-bootstrap) FINISH=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$APP_DIR"
project=$(node -e 'try{console.log(require("./.vercel/project.json").projectName||"")}catch{console.log("")}')
if [ "$project" != "$EXPECTED_PROJECT" ]; then
  echo "Refusing: $APP_DIR is linked to '${project:-nothing}', expected '$EXPECTED_PROJECT'." >&2
  exit 1
fi

put() {
  vercel env rm "$1" production -y >/dev/null 2>&1 || true
  printf '%s' "$2" | vercel env add "$1" production ${3:-} >/dev/null
  echo "set $1"
}

if [ "$FINISH" = 1 ]; then
  vercel env rm KEYGEN_BOOTSTRAP production -y >/dev/null 2>&1 || true
  vercel env rm KEYGEN_ADMIN_PASSWORD production -y >/dev/null 2>&1 || true
  echo "Bootstrap vars removed. Redeploy: (cd $APP_DIR && vercel deploy --prod)"
  exit 0
fi

[ -n "$POOLER_URI" ] && [ -n "$ADMIN_EMAIL" ] || { echo "need --pooler-uri and --admin-email" >&2; exit 2; }
case "$POOLER_URI" in *'[YOUR-PASSWORD]'*) ;; *) echo "pooler URI must contain [YOUR-PASSWORD]" >&2; exit 2 ;; esac

if [ ! -f "$SECRETS" ]; then
  umask 077
  {
    echo "SECRET_KEY_BASE=$(openssl rand -hex 64)"
    echo "ENCRYPTION_DETERMINISTIC_KEY=$(openssl rand -base64 32)"
    echo "ENCRYPTION_PRIMARY_KEY=$(openssl rand -base64 32)"
    echo "ENCRYPTION_KEY_DERIVATION_SALT=$(openssl rand -base64 32)"
    echo "KEYGEN_ACCOUNT_ID=$(uuidgen | tr 'A-Z' 'a-z')"
    echo "KEYGEN_ADMIN_EMAIL=$ADMIN_EMAIL"
    echo "KEYGEN_ADMIN_PASSWORD=$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)"
    echo "KEYGEN_HOST=$EXPECTED_PROJECT.vercel.app"
  } > "$SECRETS"
  chmod 600 "$SECRETS"
  echo "Generated $SECRETS (back this up in your password manager)."
fi
set -a; . "$SECRETS"; set +a

DB_PASSWORD="$(grep -v '^[[:space:]]*$' "$HOME/.dbpassword" | head -n1 | tr -d '\r\n')"
DATABASE_URL="$(POOLER_URI="$POOLER_URI" DB_PASSWORD="$DB_PASSWORD" node -e \
  'process.stdout.write(process.env.POOLER_URI.replace("[YOUR-PASSWORD]", encodeURIComponent(process.env.DB_PASSWORD)) + (process.env.POOLER_URI.includes("?") ? "&" : "?") + "sslmode=require")')"

put DATABASE_URL "$DATABASE_URL" --sensitive
put SECRET_KEY_BASE "$SECRET_KEY_BASE" --sensitive
put ENCRYPTION_DETERMINISTIC_KEY "$ENCRYPTION_DETERMINISTIC_KEY" --sensitive
put ENCRYPTION_PRIMARY_KEY "$ENCRYPTION_PRIMARY_KEY" --sensitive
put ENCRYPTION_KEY_DERIVATION_SALT "$ENCRYPTION_KEY_DERIVATION_SALT" --sensitive
put KEYGEN_ADMIN_PASSWORD "$KEYGEN_ADMIN_PASSWORD" --sensitive
put KEYGEN_ACCOUNT_ID "$KEYGEN_ACCOUNT_ID"
put KEYGEN_ADMIN_EMAIL "$KEYGEN_ADMIN_EMAIL"
put KEYGEN_HOST "$KEYGEN_HOST"
put KEYGEN_EDITION CE
put KEYGEN_MODE singleplayer
put KEYGEN_BOOTSTRAP 1
put PORT 3000

echo "Done. Deploy: (cd $APP_DIR && vercel deploy --prod)"
