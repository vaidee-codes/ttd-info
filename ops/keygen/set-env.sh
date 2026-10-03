#!/usr/bin/env bash
# Production Keygen (Vercel project ttd-keygen) env setup. Reads ~/.dbpassword locally;
# generates Keygen secrets once into ~/.ttd-keygen-prod.env (chmod 600 — back it up).
#   ./set-env.sh --admin-email you@example.com   # first boot: session pooler + one-time setup
#   ./set-env.sh --finish                          # after setup: transaction pooler, bootstrap vars removed
set -euo pipefail

cd "$(dirname "$0")"
EXPECTED_PROJECT="ttd-keygen"
SECRETS="$HOME/.ttd-keygen-prod.env"
DB_USER="postgres.tyiwglnvusbdjvfgbxjm"
DB_HOST="aws-0-ap-south-1.pooler.supabase.com"
DB_NAME="keygen_prod"

ADMIN_EMAIL=""; FINISH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --finish) FINISH=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

project=$(node -e 'try{console.log(require("./.vercel/project.json").projectName||"")}catch{console.log("")}')
[ "$project" = "$EXPECTED_PROJECT" ] || { echo "Refusing: linked to '${project:-nothing}', expected '$EXPECTED_PROJECT'." >&2; exit 1; }

put() {
  vercel env rm "$1" production -y >/dev/null 2>&1 || true
  printf '%s' "$2" | vercel env add "$1" production ${3:-} >/dev/null 2>&1
  echo "set $1"
}
database_url() {
  DB_PASSWORD="$(grep -v '^[[:space:]]*$' "$HOME/.dbpassword" | head -n1 | tr -d '\r\n')" PORT="$1" \
    DB_USER="$DB_USER" DB_HOST="$DB_HOST" DB_NAME="$DB_NAME" node -e \
    'const e=process.env; process.stdout.write(`postgresql://${e.DB_USER}:${encodeURIComponent(e.DB_PASSWORD)}@${e.DB_HOST}:${e.PORT}/${e.DB_NAME}?sslmode=require`)'
}

if [ "$FINISH" = 1 ]; then
  put DATABASE_URL "$(database_url 6543)" --sensitive
  vercel env rm KEYGEN_BOOTSTRAP production -y >/dev/null 2>&1 || true
  vercel env rm KEYGEN_ADMIN_PASSWORD production -y >/dev/null 2>&1 || true
  echo "Transaction pooler set; bootstrap vars removed. Redeploy with: vercel deploy --prod --yes"
  exit 0
fi

[ -n "$ADMIN_EMAIL" ] || { echo "need --admin-email" >&2; exit 2; }
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
  echo "Generated $SECRETS — store it in your password manager."
fi
set -a; . "$SECRETS"; set +a

put DATABASE_URL "$(database_url 5432)" --sensitive
for v in SECRET_KEY_BASE ENCRYPTION_DETERMINISTIC_KEY ENCRYPTION_PRIMARY_KEY ENCRYPTION_KEY_DERIVATION_SALT KEYGEN_ADMIN_PASSWORD; do
  put "$v" "${!v}" --sensitive
done
put KEYGEN_ACCOUNT_ID "$KEYGEN_ACCOUNT_ID"
put KEYGEN_ADMIN_EMAIL "$KEYGEN_ADMIN_EMAIL"
put KEYGEN_HOST "$KEYGEN_HOST"
put KEYGEN_EDITION CE
put KEYGEN_MODE singleplayer
put KEYGEN_BOOTSTRAP 1
put PORT 3000
echo "Done. Deploy with: vercel deploy --prod --yes"
