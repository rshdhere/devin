# Preview edge (Caddy)

Lovable-style preview URLs:

```text
https://{slug}.3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby
```

## Architecture

```text
Browser → Cloudflare (DNS-only A/wildcard)
       → EIP 13.203.173.88 (NLB internet-facing)
       → Caddy :80/:443 on FC host (on_demand_tls)
       → Scheduler :9091 Host router
       → microVM app :3000
```

The FC host stays in a private subnet. Do **not** attach an EIP to the
instance, and do **not** reuse the production NAT EIP (`13.206.52.124`).

## One-time ops

```bash
# 1) Dedicated EIP + NLB + security group
AWS_REGION=ap-south-1 ./infra/scripts/enable-preview-edge.sh

# 2) Install Caddy on the FC host
AWS_REGION=ap-south-1 ./infra/scripts/install-preview-caddy-ssm.sh

# 3) Cloudflare DNS (grey cloud / DNS-only) — dashboard or API:
#    A    3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby    → 13.203.173.88
#    A  *.3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby    → 13.203.173.88
CF_API_TOKEN=... ./infra/scripts/apply-preview-dns-cloudflare.sh
```

Prefer **DNS-only** (grey cloud) so Caddy on-demand TLS / Let’s Encrypt can complete
tls-alpn-01 against the NLB EIP. Orange-cloud can break or complicate ACME.

Production defaults:

| Resource | Value |
|----------|-------|
| Preview EIP | `13.203.173.88` (`eipalloc-0b6ef730130f9b781`) |
| NLB | `devin-production-preview` |
| Host | `i-07232620d98d8c7fd` |
| SG rule | `0.0.0.0/0` → TCP 80/443 |

## Verify

```bash
# DNS (after Cloudflare records exist)
dig +short 3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby
dig +short test.3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby
# expect 13.203.173.88

# Edge / scheduler (on the FC host)
curl -fsS http://127.0.0.1:9091/health
curl -fsS 'http://127.0.0.1:9091/internal/v1/preview/tls-allowed?domain=abc123xyz.3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby'
# → 200

# Public HTTP → Caddy (should 308 to HTTPS once DNS works)
curl -sSI http://13.203.173.88/ | head -5

# End-to-end HTTPS for a live preview slug
curl -fsS https://<slug>.3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby/health
```

## Rollout status (Jul 2026)

| Step | Status |
|------|--------|
| Dedicated EIP `13.203.173.88` + NLB `devin-production-preview` | done |
| SG 80/443 open on FC host | done |
| Caddy on host (`:443` on_demand → `:9091`) | done |
| Scheduler TLS ask `/internal/v1/preview/tls-allowed` | done (image `preview-caddy-20260715`) |
| Cloudflare A + `*` DNS-only → EIP | **manual** — run `apply-preview-dns-cloudflare.sh` or create in dashboard |
