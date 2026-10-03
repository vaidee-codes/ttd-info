#!/usr/bin/env bash
# Creates the Keygen VPS on AWS Lightsail (Mumbai). Idempotent: skips what exists.
#   ./create-lightsail.sh            # 1 GB plan (micro_3_1, $7/mo)
#   BUNDLE=small_3_1 ./create-lightsail.sh   # 2 GB plan ($12/mo)
set -euo pipefail

PROFILE="${AWS_PROFILE_NAME:-ttd}"
REGION="ap-south-1"
AZ="ap-south-1a"
NAME="ttd-keygen"
IP_NAME="ttd-keygen-ip"
KEY_NAME="ttd-keygen-ssh"
BUNDLE="${BUNDLE:-micro_3_1}"
BLUEPRINT="ubuntu_24_04"
PUBKEY="$HOME/.ssh/oci_keygen_spike.pub"
aws() { command rtk proxy aws "$@" --profile "$PROFILE" --region "$REGION"; }

if ! aws lightsail get-key-pair --key-pair-name "$KEY_NAME" >/dev/null 2>&1; then
  aws lightsail import-key-pair --key-pair-name "$KEY_NAME" --public-key-base64 "$(cat "$PUBKEY")" >/dev/null
  echo "imported key pair $KEY_NAME"
fi

if ! aws lightsail get-instance --instance-name "$NAME" >/dev/null 2>&1; then
  aws lightsail create-instances --instance-names "$NAME" --availability-zone "$AZ" \
    --blueprint-id "$BLUEPRINT" --bundle-id "$BUNDLE" --key-pair-name "$KEY_NAME" \
    --ip-address-type dualstack --tags key=project,value=ttd-autofill key=role,value=keygen >/dev/null
  echo "creating instance $NAME ($BUNDLE)"
fi

for _ in $(seq 1 40); do
  state=$(aws lightsail get-instance-state --instance-name "$NAME" --query 'state.name' --output text)
  [ "$state" = "running" ] && break
  sleep 5
done
echo "instance state: $state"

if ! aws lightsail get-static-ip --static-ip-name "$IP_NAME" >/dev/null 2>&1; then
  aws lightsail allocate-static-ip --static-ip-name "$IP_NAME" >/dev/null
  echo "allocated static IP $IP_NAME"
fi
attached=$(aws lightsail get-static-ip --static-ip-name "$IP_NAME" --query 'staticIp.attachedTo' --output text)
if [ "$attached" != "$NAME" ]; then
  aws lightsail attach-static-ip --static-ip-name "$IP_NAME" --instance-name "$NAME" >/dev/null
  echo "attached static IP"
fi

MY_IP="$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')"
aws lightsail put-instance-public-ports --instance-name "$NAME" --port-infos \
  "fromPort=22,toPort=22,protocol=tcp,cidrs=$MY_IP/32" \
  "fromPort=80,toPort=80,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0" \
  "fromPort=443,toPort=443,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0" >/dev/null
echo "ports: 22 from $MY_IP only; 80/443 open"

IP=$(aws lightsail get-static-ip --static-ip-name "$IP_NAME" --query 'staticIp.ipAddress' --output text)
echo "public IP: $IP  →  hostname: ${IP//./-}.sslip.io"
