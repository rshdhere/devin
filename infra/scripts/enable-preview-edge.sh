#!/usr/bin/env bash
# Wire Lovable-style public preview edge:
#   Internet-facing NLB (dedicated EIP) in a public subnet → FC host :80/:443 (Caddy)
#
# The FC host sits in a private subnet (NAT only). Associating an EIP to the
# instance itself will not accept inbound internet traffic — use an NLB.
#
# NEVER reuse the production NAT EIP (devin-production-nat-eip-1 / 13.206.52.124).
#
# Defaults (production Path B, Jul 2026):
#   INSTANCE_ID=i-07232620d98d8c7fd
#   EIP_ALLOC=eipalloc-0b6ef730130f9b781  (13.203.173.88 — preview-only)
#   PUBLIC_SUBNET=subnet-0e0a641ceabdd7ebb (devin-production-public-ap-south-1a)
#   SG=sg-0b1621a5f8c8d20f1
#
# Usage:
#   AWS_REGION=ap-south-1 ./enable-preview-edge.sh
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-south-1}"
INSTANCE_ID="${INSTANCE_ID:-i-07232620d98d8c7fd}"
EIP_ALLOC="${EIP_ALLOC:-eipalloc-0b6ef730130f9b781}"
PUBLIC_SUBNET="${PUBLIC_SUBNET:-subnet-0e0a641ceabdd7ebb}"
SG_ID="${SG_ID:-sg-0b1621a5f8c8d20f1}"
NLB_NAME="${NLB_NAME:-devin-production-preview}"
TG80_NAME="${TG80_NAME:-devin-production-preview-80}"
TG443_NAME="${TG443_NAME:-devin-production-preview-443}"
# Hard deny-list: production NAT must never be stolen for preview.
NAT_EIP_ALLOC="eipalloc-066446ca16c44b113"

if [[ "$EIP_ALLOC" == "$NAT_EIP_ALLOC" ]]; then
  echo "Refusing to use NAT EIP $NAT_EIP_ALLOC for preview edge." >&2
  echo "Allocate a dedicated EIP and pass EIP_ALLOC=..." >&2
  exit 1
fi

PUBLIC_IP="$(aws ec2 describe-addresses \
  --region "$AWS_REGION" \
  --allocation-ids "$EIP_ALLOC" \
  --query 'Addresses[0].PublicIp' \
  --output text)"

echo "Ensuring SG $SG_ID allows 80/443 from the internet (NLB preserves client IP)"
for port in 80 443; do
  if aws ec2 authorize-security-group-ingress \
    --region "$AWS_REGION" \
    --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=${port},ToPort=${port},IpRanges=[{CidrIp=0.0.0.0/0,Description=preview-caddy}]" \
    2>/dev/null; then
    echo "  opened tcp/${port}"
  else
    echo "  tcp/${port} already present"
  fi
done

# Only disassociate if this EIP is free-floating from a non-NAT attachment.
# Never touch NAT gateway associations.
ASSOC="$(aws ec2 describe-addresses \
  --region "$AWS_REGION" \
  --allocation-ids "$EIP_ALLOC" \
  --query 'Addresses[0].AssociationId' \
  --output text)"
NI="$(aws ec2 describe-addresses \
  --region "$AWS_REGION" \
  --allocation-ids "$EIP_ALLOC" \
  --query 'Addresses[0].NetworkInterfaceId' \
  --output text)"
if [[ -n "$ASSOC" && "$ASSOC" != "None" ]]; then
  if aws ec2 describe-nat-gateways \
    --region "$AWS_REGION" \
    --filter "Name=state,Values=available" \
    --query "NatGateways[?NatGatewayAddresses[0].AllocationId=='${EIP_ALLOC}'].NatGatewayId | [0]" \
    --output text 2>/dev/null | grep -q '^nat-'; then
    echo "EIP $EIP_ALLOC is attached to a NAT gateway — aborting" >&2
    exit 1
  fi
  # If already on an NLB ENI we cannot disassociate freely; reuse NLB instead.
  echo "EIP currently associated ($ASSOC / $NI) — continuing (NLB create will fail if EIP is busy)"
fi

find_lb() {
  aws elbv2 describe-load-balancers \
    --region "$AWS_REGION" \
    --names "$NLB_NAME" \
    --query 'LoadBalancers[0].LoadBalancerArn' \
    --output text 2>/dev/null || true
}

LB_ARN="$(find_lb)"
if [[ -z "$LB_ARN" || "$LB_ARN" == "None" ]]; then
  echo "Creating internet-facing NLB $NLB_NAME with EIP $PUBLIC_IP"
  LB_ARN="$(aws elbv2 create-load-balancer \
    --region "$AWS_REGION" \
    --name "$NLB_NAME" \
    --type network \
    --scheme internet-facing \
    --subnet-mappings "SubnetId=${PUBLIC_SUBNET},AllocationId=${EIP_ALLOC}" \
    --tags "Key=Name,Value=${NLB_NAME}" "Key=Project,Value=devin" "Key=Environment,Value=production" \
    --query 'LoadBalancers[0].LoadBalancerArn' \
    --output text)"
else
  echo "Reusing NLB $LB_ARN"
fi

VPC_ID="$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].VpcId' \
  --output text)"

ensure_tg() {
  local name="$1" port="$2"
  local arn
  arn="$(aws elbv2 describe-target-groups \
    --region "$AWS_REGION" \
    --names "$name" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text 2>/dev/null || true)"
  if [[ -z "$arn" || "$arn" == "None" ]]; then
    arn="$(aws elbv2 create-target-group \
      --region "$AWS_REGION" \
      --name "$name" \
      --protocol TCP \
      --port "$port" \
      --vpc-id "$VPC_ID" \
      --target-type instance \
      --health-check-protocol TCP \
      --health-check-port traffic-port \
      --query 'TargetGroups[0].TargetGroupArn' \
      --output text)"
  fi
  aws elbv2 register-targets \
    --region "$AWS_REGION" \
    --target-group-arn "$arn" \
    --targets "Id=${INSTANCE_ID},Port=${port}" >/dev/null
  echo "$arn"
}

echo "Ensuring target groups → $INSTANCE_ID"
TG80_ARN="$(ensure_tg "$TG80_NAME" 80)"
TG443_ARN="$(ensure_tg "$TG443_NAME" 443)"

ensure_listener() {
  local port="$1" tg_arn="$2"
  local existing
  existing="$(aws elbv2 describe-listeners \
    --region "$AWS_REGION" \
    --load-balancer-arn "$LB_ARN" \
    --query "Listeners[?Port==\`${port}\`].ListenerArn | [0]" \
    --output text 2>/dev/null || true)"
  if [[ -z "$existing" || "$existing" == "None" ]]; then
    aws elbv2 create-listener \
      --region "$AWS_REGION" \
      --load-balancer-arn "$LB_ARN" \
      --protocol TCP \
      --port "$port" \
      --default-actions "Type=forward,TargetGroupArn=${tg_arn}" >/dev/null
    echo "  created listener :${port}"
  else
    aws elbv2 modify-listener \
      --region "$AWS_REGION" \
      --listener-arn "$existing" \
      --default-actions "Type=forward,TargetGroupArn=${tg_arn}" >/dev/null
    echo "  updated listener :${port}"
  fi
}

echo "Ensuring NLB listeners"
ensure_listener 80 "$TG80_ARN"
ensure_listener 443 "$TG443_ARN"

LB_DNS="$(aws elbv2 describe-load-balancers \
  --region "$AWS_REGION" \
  --load-balancer-arns "$LB_ARN" \
  --query 'LoadBalancers[0].DNSName' \
  --output text)"

echo
echo "Preview edge NLB ready:"
echo "  EIP:     ${PUBLIC_IP}"
echo "  NLB DNS: ${LB_DNS}"
echo
echo "Cloudflare DNS (DNS-only / grey cloud):"
echo "  A   3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby     → ${PUBLIC_IP}"
echo "  A   *.3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby   → ${PUBLIC_IP}"
