# HashiCorp Vault — secret management for devin.baby

All application secrets live in **Vault KV v2** instead of `.env` files, plain Kubernetes Secrets, or CI variables. This directory is the foundation; app code and GitOps manifests consume secrets via injection or sync.

## Secret layout

| Vault path | Consumers | Keys |
| --- | --- | --- |
| `secret/dev/server` | API server (local) | `BETTER_AUTH_SECRET`, `DATABASE_URL`, `SCHEDULER_URL`, OAuth, Resend, `GITHUB_BOT_TOKEN` |
| `secret/dev/scheduler` | Scheduler (local / EC2) | `ORCHESTRATOR_URL`, `CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_BOT_*` |
| `secret/dev/ci` | GitHub Actions (local) | `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WEB_APP_URL` |
| `secret/staging/server` | EKS `devin-staging` server | Same keys as dev; use staging hostnames |
| `secret/staging/scheduler` | EKS `devin-staging` scheduler | Same keys as dev/scheduler |
| `secret/staging/ci` | GitHub Actions (staging web build) | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WEB_APP_URL` for staging |
| `secret/prod/server` | EKS `devin-app` server | Same as dev |
| `secret/prod/scheduler` | EKS `devin-app` / EC2 scheduler | Scheduler + agent keys + `GITHUB_BOT_*` |
| `secret/prod/ci` | GitHub Actions (production web build) | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WEB_APP_URL` for production |

### GitHub Bot Token (GITHUB_BOT_*)

The platform bot (`baby-devin-bot`) enables repository creation for greenfield tasks. Required keys:

| Key | Required | Description |
| --- | --- | --- |
| `GITHUB_BOT_TOKEN` | **Yes** | GitHub PAT (classic) with `repo` scope for the bot account |
| `GITHUB_BOT_NAME` | No | Bot username (default: `baby-devin-bot`) |
| `GITHUB_BOT_EMAIL` | No | Bot email (default: `baby-devin-bot@users.noreply.github.com`) |

**Both `server` and `scheduler` paths need `GITHUB_BOT_TOKEN`**:
- Server uses it to show bot status in the UI
- Scheduler uses it to create repositories

## Local development

```sh
# 1. Start Vault (dev mode)
docker compose -f vault/docker-compose.yaml up -d

# 2. Bootstrap engines, policies, placeholder secrets
chmod +x vault/bootstrap/local.sh vault/scripts/vault-env.sh
./vault/bootstrap/local.sh

# 3. Load secrets into your shell
source vault/scripts/vault-env.sh server
bun run dev --filter=@devin/server

# 4. Update a secret
vault kv put secret/dev/server BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
```

Vault UI: http://127.0.0.1:8200/ui (token: `dev-root-token`)

## Production (EKS)

### 1. Enable in Terraform

```hcl
# infra/terraform.tfvars
enable_vault           = true
vault_ha_enabled       = true   # prod: 3-replica Raft
vault_ingress_enabled  = true
vault_ingress_host     = "vault.internal.example.com"
```

```sh
cd infra && terraform apply
terraform output -raw vault_init_commands
```

### 2. Initialize Vault (once)

```sh
kubectl -n vault port-forward svc/vault 8200:8200
export VAULT_ADDR=http://127.0.0.1:8200
vault operator init   # save recovery keys + root token securely
```

With **AWS KMS auto-unseal**, Vault unseals automatically after init.

### 3. Bootstrap auth and policies

```sh
export VAULT_TOKEN=<root-token>
./vault/bootstrap/kubernetes.sh --env prod --cluster devin
```

### 4. Store production secrets

```sh
vault kv put secret/prod/server \
  BETTER_AUTH_SECRET="..." \
  DATABASE_URL="postgres://...@ep-xxx.neon.tech/devin?sslmode=require" \
  SCHEDULER_URL="http://10.0.15.247:9091" \
  GITHUB_CLIENT_ID="..." \
  GITHUB_CLIENT_SECRET="..." \
  GITHUB_BOT_TOKEN="ghp_xxx" \
  GITHUB_BOT_NAME="baby-devin-bot" \
  RESEND_API_KEY="..."

vault kv put secret/prod/scheduler \
  ORCHESTRATOR_URL="http://<orchestrator-nlb>:9090" \
  CURSOR_API_KEY="..." \
  ANTHROPIC_API_KEY="..." \
  DEFAULT_AGENT="cursor" \
  GITHUB_BOT_TOKEN="ghp_xxx" \
  GITHUB_BOT_NAME="baby-devin-bot" \
  GITHUB_BOT_EMAIL="baby-devin-bot@users.noreply.github.com"
```

### 5. Wire workloads

Choose one integration pattern (examples in `vault/examples/`):

| Pattern | Best for |
| --- | --- |
| **External Secrets Operator** | GitOps-friendly sync to K8s `Secret` |
| **Vault Agent Injector** | Sidecar file injection, no K8s Secret |
| **AppRole + script** | EC2 execution hosts (scheduler) |

## Policies

| Policy | Access |
| --- | --- |
| `server` | Read `secret/*/server` |
| `scheduler` | Read `secret/*/scheduler` |
| `ci` | Read `secret/*/ci` |
| `admin` | Full secret + auth management (break-glass) |

Policies live in `vault/config/policies/`.

## CI/CD

Migrate GitHub Actions secrets to Vault:

```sh
vault kv put secret/prod/ci \
  DOCKERHUB_USERNAME="..." \
  DOCKERHUB_TOKEN="..." \
  NEXT_PUBLIC_API_URL="https://api.devin.baby" \
  NEXT_PUBLIC_WEB_APP_URL="https://devin.baby"
```

In `.github/workflows/registry.yaml`, replace `${{ secrets.* }}` with a job that authenticates to Vault (OIDC or AppRole) and exports credentials before `docker login`. A full CI integration can be added in a follow-up.

## Directory layout

```text
vault/
├── docker-compose.yaml       # Local dev Vault
├── config/policies/          # HCL access policies
├── bootstrap/
│   ├── local.sh              # Dev bootstrap
│   └── kubernetes.sh         # EKS auth + AppRole setup
├── scripts/
│   └── vault-env.sh          # Export KV → shell env (local dev)
└── examples/
    ├── external-secrets.yaml # ESO GitOps manifest
    └── ec2-scheduler-vault.sh
```

## Security notes

- Never commit `vault/.local/`, root tokens, or AppRole credentials.
- Use KMS auto-unseal in production (provisioned by `infra/modules/vault`).
- Restrict Vault ingress to VPC-internal DNS; terminate TLS at the load balancer.
- Rotate `BETTER_AUTH_SECRET` and OAuth client secrets through Vault versions (KV v2 keeps history).
