#!/usr/bin/env bash
# Apply Cloudflare DNS for Lovable-style preview wildcard (DNS-only / grey cloud).
#
# Requires:
#   CF_API_TOKEN  — Zone.DNS Edit on zone devin.baby
#   CF_ZONE_ID    — optional; auto-resolved from CF_ZONE_NAME (default: devin.baby)
#
# Records created/updated (proxied=false):
#   A    3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby     → PREVIEW_EIP
#   A  *.3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby     → PREVIEW_EIP
#
# Usage:
#   CF_API_TOKEN=... PREVIEW_EIP=13.203.173.88 ./apply-preview-dns-cloudflare.sh
set -euo pipefail

CF_API_TOKEN="${CF_API_TOKEN:?set CF_API_TOKEN}"
CF_ZONE_NAME="${CF_ZONE_NAME:-devin.baby}"
PREVIEW_BASE="${PREVIEW_BASE:-3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby}"
PREVIEW_EIP="${PREVIEW_EIP:-13.203.173.88}"
API="https://api.cloudflare.com/client/v4"

auth_hdr=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")

if [[ -z "${CF_ZONE_ID:-}" ]]; then
  CF_ZONE_ID="$(curl -fsS "${auth_hdr[@]}" \
    "${API}/zones?name=${CF_ZONE_NAME}" \
    | jq -r '.result[0].id // empty')"
  [[ -n "$CF_ZONE_ID" ]] || {
    echo "Could not resolve zone id for ${CF_ZONE_NAME}" >&2
    exit 1
  }
fi

upsert_a() {
  local name="$1"
  local existing id
  existing="$(curl -fsS "${auth_hdr[@]}" \
    "${API}/zones/${CF_ZONE_ID}/dns_records?type=A&name=${name}" \
    | jq -c '.result[0] // empty')"
  if [[ -n "$existing" && "$existing" != "null" ]]; then
    id="$(jq -r '.id' <<<"$existing")"
    curl -fsS -X PUT "${auth_hdr[@]}" \
      "${API}/zones/${CF_ZONE_ID}/dns_records/${id}" \
      --data "$(jq -n --arg name "$name" --arg ip "$PREVIEW_EIP" \
        '{type:"A",name:$name,content:$ip,ttl:60,proxied:false}')" \
      | jq -r '"updated \(.result.name) -> \(.result.content) proxied=\(.result.proxied)"'
  else
    curl -fsS -X POST "${auth_hdr[@]}" \
      "${API}/zones/${CF_ZONE_ID}/dns_records" \
      --data "$(jq -n --arg name "$name" --arg ip "$PREVIEW_EIP" \
        '{type:"A",name:$name,content:$ip,ttl:60,proxied:false}')" \
      | jq -r '"created \(.result.name) -> \(.result.content) proxied=\(.result.proxied)"'
  fi
}

echo "Zone ${CF_ZONE_NAME} (${CF_ZONE_ID}) → EIP ${PREVIEW_EIP}"
upsert_a "$PREVIEW_BASE"
upsert_a "*.${PREVIEW_BASE}"

echo
echo "Verify (may take ~60s):"
echo "  dig +short ${PREVIEW_BASE}"
echo "  dig +short test.${PREVIEW_BASE}"
