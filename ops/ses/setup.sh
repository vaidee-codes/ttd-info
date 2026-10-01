#!/usr/bin/env bash
# Creates the SES sender for licence emails and wires it into the TEST app (ttd-info-keygen).
# Usage: ops/ses/setup.sh            (needs: aws login --profile ttd ; vercel CLI linked to ttd-info-keygen)
# Prints the DNS records to add in Cloudflare. Never prints the secret key.
set -euo pipefail
PROFILE=${AWS_PROFILE:-ttd}; REGION=ap-south-1; STACK=ttd-autofill-ses
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
grep -q '"projectName":"ttd-info-keygen"' "$ROOT/.vercel/project.json" || { echo "refusing: not linked to ttd-info-keygen"; exit 1; }

aws cloudformation deploy --profile "$PROFILE" --region "$REGION" --stack-name "$STACK" \
  --template-file "$HERE/ses-stack.yaml" --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset

echo; echo "== Add these DNS records in Cloudflare (DNS only, grey cloud) =="
aws cloudformation describe-stacks --profile "$PROFILE" --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?starts_with(OutputKey,'Dkim')].OutputValue" --output text | tr '\t' '\n'
echo "ses.ttd-autofill.com MX 10 feedback-smtp.$REGION.amazonses.com"
echo "ses.ttd-autofill.com TXT \"v=spf1 include:amazonses.com ~all\""

if [ "$(aws iam list-access-keys --profile "$PROFILE" --user-name ttd-ses-sender --query 'length(AccessKeyMetadata)' --output text)" = "0" ]; then
  KEY_JSON=$(aws iam create-access-key --profile "$PROFILE" --user-name ttd-ses-sender --output json)
  cd "$ROOT"
  for name in SES_ACCESS_KEY_ID SES_SECRET_ACCESS_KEY; do vercel env rm "$name" production --yes >/dev/null 2>&1 || true; done
  printf %s "$(printf %s "$KEY_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccessKey"]["AccessKeyId"],end="")')" | vercel env add SES_ACCESS_KEY_ID production >/dev/null
  printf %s "$(printf %s "$KEY_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccessKey"]["SecretAccessKey"],end="")')" | vercel env add SES_SECRET_ACCESS_KEY production >/dev/null
  unset KEY_JSON
  for kv in "SES_REGION=$REGION" "SES_CONFIGURATION_SET=ttd-autofill-transactional"; do
    vercel env rm "${kv%%=*}" production --yes >/dev/null 2>&1 || true
    printf %s "${kv#*=}" | vercel env add "${kv%%=*}" production >/dev/null
  done
  echo; echo "SES keys stored in Vercel (ttd-info-keygen, production). Redeploy to use them."
else
  echo; echo "ttd-ses-sender already has an access key; Vercel env left unchanged."
fi
echo; echo "Identity status:"; aws sesv2 get-email-identity --profile "$PROFILE" --region "$REGION" --email-identity ttd-autofill.com \
  --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}' --output table
echo; echo "Account:"; aws sesv2 get-account --profile "$PROFILE" --region "$REGION" --query '{production:ProductionAccessEnabled,max24h:SendQuota.Max24HourSend,perSecond:SendQuota.MaxSendRate}' --output table
