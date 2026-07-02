# Terraform — devin.baby AWS infrastructure

Terraform provisions the **AWS foundation** for [deployment.md](../deployment.md) **Path B** (EKS control plane + external EC2 Firecracker execution hosts + Neon Postgres outside AWS).

Container images are expected on **Docker Hub** (not ECR). Configure `imagePullSecrets` in your GitOps repo for private repos on EKS.

## Architecture

```text
                         ┌─────────────────────────────────────┐
                         │           EKS (this repo)            │
                         │  web, server, orchestrator           │
                         │  private subnets                     │
                         └──────────────┬──────────────────────┘
                                        │
                    VPC 10.0.0.0/16     │
         ┌──────────────────────────────┼──────────────────────────────┐
         │  Execution host(s) EC2       │    NAT → public subnets      │
         │  firecracker-host :9092      │    (ALB / NLB via GitOps)    │
         │  scheduler        :9091    │                              │
         └──────────────────────────────┴──────────────────────────────┘

         Neon Postgres — provision separately (not in this Terraform)
         Docker Hub    — container images (not provisioned here)
```

| Module | Purpose |
| --- | --- |
| `modules/vpc` | Multi-AZ VPC, internet gateway, public/private route tables, NAT gateway(s) |
| `modules/eks` | EKS cluster + managed node group (control plane only) |
| `modules/execution-hosts` | EC2 Firecracker hosts and security groups |
| `modules/vault` | HashiCorp Vault on EKS with AWS KMS auto-unseal (optional) |

**Do not** run Firecracker on EKS workers. Execution hosts are dedicated EC2 instances with `/dev/kvm`.

## Prerequisites

- Terraform >= 1.6
- AWS CLI configured (`aws sts get-caller-identity`)
- IAM permissions for VPC, EKS, EC2, IAM
- Docker Hub images pushed (`<container_registry>/devin-server`, etc.)

## Quick start

`terraform.tfvars` is **gitignored** on purpose (it holds account-specific values). It is not missing — you create it locally from the example:

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars (region, container_registry, SSH key, admin CIDRs)
```

Minimum edits in `terraform.tfvars`:

| Variable | Example |
| --- | --- |
| `container_registry` | `docker.io/rshdhere` (required — no default) |
| `execution_host_ssh_key_name` | your EC2 key pair name in AWS |
| `execution_host_admin_ssh_cidr_blocks` | `["203.0.113.10/32"]` (your public IP) |

Then:

```sh
terraform init
terraform plan
terraform apply
```

If `terraform plan` errors on the Helm provider (`kubernetes` block), run `terraform init -upgrade` after pulling the latest `infra/providers.tf` (Helm provider v3 syntax).

Configure kubectl after apply:

```sh
$(terraform output -raw configure_kubectl)
kubectl get nodes
```

## Container images (Docker Hub)

Set `container_registry` in `terraform.tfvars` (e.g. `docker.io/youruser`). Image names match deployment.md:

| Image | Pull reference |
| --- | --- |
| server | `<container_registry>/devin-server:<tag>` |
| web | `<container_registry>/devin-web:<tag>` |
| orchestrator | `<container_registry>/devin-orchestrator:<tag>` |
| scheduler | `<container_registry>/devin-scheduler:<tag>` |
| firecracker-host | `<container_registry>/devin-firecracker-host:<tag>` |

On **EKS**, add a `kubernetes.io/dockerconfigjson` secret and reference it in your GitOps manifests for private repos.

On **execution hosts**, run `docker login` before enabling the systemd units if repos are private.

### CI/CD (execution plane)

| Workflow | Trigger | What it does |
| --- | --- | --- |
| **Registry** | push to `main` | Builds and pushes all images including `devin-scheduler` and `devin-firecracker-host` |
| **Deploy execution hosts** | after Registry on `main`; or manual | SSM: `docker pull` + restart scheduler and firecracker-host on EC2 |
| **build-check** | push / PR | Compiles Go services and dry-builds the scheduler Docker image |

Execution hosts are **not** rolled by GitOps. Runtime golden snapshots require a manual deploy with `rebuild_runtime_snapshots=true` or `./infra/scripts/run-ssm-bootstrap-snapshots.sh`.

GitHub variables: `AWS_IAM_SYNC_ROLE_ARN` (required for deploy; from `infra/iam`), optional `AWS_DEPLOY_ROLE_ARN`, `EXECUTION_HOST_INSTANCE_IDS`, `AWS_REGION`.

**One-time:** `cd infra/iam && terraform apply` to attach SSM deploy permissions to the sync role.

Manual deploy:

```bash
DEVIN_IMAGE_TAG=<git-sha> ./infra/scripts/deploy-execution-host-images.sh --discover
```

## Outputs

After `terraform apply`, note:

- `container_registry` — Docker Hub prefix for image references
- `execution_hosts` — private IPs for GitOps `FirecrackerHost` CRs
- `scheduler_url` — primary scheduler URL for `devin-server` (`SCHEDULER_URL`)
- `orchestrator_url` — orchestrator endpoint for execution host schedulers
- `task_queue_url` — SQS queue for durable scheduler jobs (execution hosts use `QUEUE_DRIVER=sqs` via SSM)
- `firecracker_hosts_gitops_path` — generated YAML to sync into GitOps
- `eks_oidc_provider_arn` — install [AWS Load Balancer Controller](https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html) via IRSA in GitOps

## Access execution hosts (private subnet)

Execution hosts have **no public IP**. Use **SSM Session Manager** (not direct SSH from the internet).

### One-time: Session Manager plugin

`aws ssm start-session` requires the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) on your laptop (separate from the AWS CLI):

```sh
./infra/scripts/install-session-manager-plugin.sh
session-manager-plugin --version
```

### Connect

```sh
cd infra
INSTANCE_ID=$(terraform output -json execution_hosts | jq -r '.["fc-01"].instance_id')
aws ssm start-session --region ap-south-1 --target "$INSTANCE_ID"
```

If you see `TargetNotConnected`:

1. Confirm `enable_ssm_iam = true` in `terraform.tfvars` and run `terraform apply`
2. Ensure `devin-infra` IAM policy includes `instance-profile/devin-*` and `ssm:ListTagsForResource` — sync via `infra/iam` (admin creds) or merge to `main` (GitHub Actions **sync-iam-policy** workflow)
3. Wait 1–2 minutes after apply for the SSM agent to register
4. Verify registration: `aws ssm describe-instance-information --filters Key=InstanceIds,Values=$INSTANCE_ID`

**Existing hosts** created before SSM was enabled need a one-time instance replace so userdata installs the SSM agent:

```sh
terraform apply -replace='module.execution_hosts[0].aws_instance.execution_host["fc-01"]'
```

(New hosts provisioned after the userdata change already include the SSM agent.)

SSH on port 22 is only reachable from `execution_host_admin_ssh_cidr_blocks` **inside the VPC** (e.g. via SSM port forwarding or a bastion), not from the public internet.

## Execution host bootstrap (Path B)

After `terraform apply`, the execution host needs **nested virtualization**, **platform sync**, and **Firecracker snapshots**.

### 1. IAM — nested virtualization

`devin-infra` needs `ec2:ModifyInstanceCpuOptions` (added in `infra/iam/devin-infra-policy.json`). Merge to `main` so GitHub Actions syncs the policy, or apply as admin:

```sh
cd infra/iam && terraform apply   # admin credentials only
```

Then enable nested virt on C7i:

```sh
./infra/scripts/enable-nested-virtualization.sh $(terraform -chdir=infra output -json execution_hosts | jq -r '."fc-01".instance_id')
```

### 2. Host bootstrap (if cloud-init failed)

Ubuntu 24.04 has no `awscli` apt package — userdata installs AWS CLI v2. If the first boot failed (missing egress HTTP/DNS), re-run:

```sh
./infra/scripts/rebootstrap-execution-host.sh <instance-id> ap-south-1
```

### 3. Firecracker snapshots

```sh
./infra/scripts/run-ssm-bootstrap-snapshots.sh <instance-id> ap-south-1
```

Verify on the host:

```sh
curl -s http://127.0.0.1:9091/health
curl -s http://127.0.0.1:9092/v1/status   # readyVMs > 0 after snapshots
ls -l /dev/kvm                             # must be a character device
```

### 4. GitOps (separate repo)

Sync `infra/generated/firecracker-hosts.yaml` into `rshdhere/ops` (`staging/devin/overlays/external/firecracker-hosts.yaml`) so the orchestrator registers the host IP.

For staging orchestrator NLB (fixes `orchestrator rejected sandbox: 500` on staging.devin.baby), apply the GitOps handoff in the ops repo — see issue/chat context for `orchestrator-lb.yaml` in the staging-external overlay.

---

1. **Neon** — create Postgres project; set `DATABASE_URL` in GitOps secrets
2. **Build & push images** to Docker Hub
3. **Execution hosts** — Terraform writes SSM platform URLs and runs SSM bootstrap; verify `curl http://127.0.0.1:9091/health` on the host
4. **GitOps** — sync `infra/generated/firecracker-hosts.yaml` (or `terraform output execution_hosts`) into your ops repo `firecracker-hosts.yaml`
5. **Ingress** — AWS Load Balancer Controller + ACM in GitOps
6. **Vault / External Secrets** — set `SCHEDULER_URL` to `terraform output -raw scheduler_url` in `secret/prod/server` and `secret/staging/server` so ESO does not overwrite kubectl patches
7. **Verify** — `kubectl -n devin-staging exec deploy/devin-server -- wget -qO- $(terraform output -raw scheduler_url)/health`

Terraform now also:

- Creates an **internal NLB** Service for `devin-orchestrator` (port 9090)
- Publishes **`scheduler_url`**, **`orchestrator_url`**, and **`task_queue_url`** to SSM (`/devin-production/platform/*`)
- Patches **`SCHEDULER_URL`** into `devin-server` secrets in `devin-app` and `devin-staging` (requires `kubectl` configured)
- Bootstraps execution hosts via **SSM** to start the scheduler with the correct `ORCHESTRATOR_URL`

### Platform agent keys (Cursor / Claude)

Store shared agent keys in **AWS SSM SecureString** parameters (not per-user). Execution hosts read them on sync:

| SSM parameter | Purpose |
| --- | --- |
| `/devin-production/platform/cursor_api_key` | Cursor agent (`CURSOR_API_KEY`) |
| `/devin-production/platform/anthropic_api_key` | Claude agent (`ANTHROPIC_API_KEY`) |
| `/devin-production/platform/openai_api_key` | Draft planner (`OPENAI_API_KEY`) |
| `/devin-production/platform/github_bot_token` | `baby-devin-bot` repo creation |

```sh
# Create or update (prompts for value)
CURSOR_API_KEY="..." ./infra/scripts/set-platform-secret.sh cursor_api_key

# Push config to a running execution host
./infra/scripts/sync-execution-host-config.sh i-0123456789abcdef0
```

Use `--with-decryption` when reading SecureString params (handled by `devin-sync-platform-config.sh`). After updating SSM, sync or restart the scheduler on each execution host.

Users can check status from the dashboard via **Advanced capabilities →** (reads scheduler diagnostics).

Disable automation when needed:

```hcl
sync_scheduler_url_to_kubernetes = false
sync_execution_host_config       = false
manage_orchestrator_nlb          = false
enable_ssm_iam                   = false
manage_ssm_parameters            = false
```

Root `terraform.tfvars` keys (do not use module-internal names):

| Variable | Purpose |
| --- | --- |
| `enable_ssm_iam` | EC2 instance profile for Session Manager on execution hosts |
| `manage_ssm_parameters` | Write scheduler/orchestrator/task-queue URLs to SSM |
| `sync_execution_host_config` | SSM Run Command bootstrap after apply |
| `sync_scheduler_url_to_kubernetes` | Patch `SCHEDULER_URL` on devin-server deployments |

## Kubernetes version upgrades

EKS upgrades **one minor version at a time** (e.g. 1.33 → 1.34, never skipping). Bump
`cluster_version` in `terraform.tfvars`, then `terraform apply`. AWS upgrades the control plane with
zero downtime; the managed node group rolls to a matching AMI. After apply, verify with
`kubectl version` and `kubectl get nodes`.

## HashiCorp Vault

When `enable_vault = true`, Terraform provisions Vault on EKS with AWS KMS auto-unseal. Store all app secrets in Vault KV (`secret/prod/server`, `secret/prod/scheduler`) instead of plain Kubernetes Secrets. Bootstrap with `./vault/bootstrap/kubernetes.sh` after `vault operator init`.

## Networking

```text
Internet
    │
    ▼
Internet Gateway ──► public route table ──► public subnets (ALB / NLB, NAT)
                              │
                              ▼
                    NAT Gateway (optional, default on)
                              │
                              ▼
                    private route table ──► private subnets (EKS nodes, Firecracker hosts)
```

| Resource | Purpose |
| --- | --- |
| **Internet gateway** | Ingress (ALB) and NAT placement in public subnets |
| **Public route table** | `0.0.0.0/0` → internet gateway |
| **NAT gateway** | Outbound internet for private subnets (Docker Hub pulls, Neon, GitHub) |
| **Private route table** | `0.0.0.0/0` → NAT gateway |

Terraform variables:

- `enable_nat_gateway = true` (default) — turn off only if workloads run in public subnets
- `single_nat_gateway = true` (default) — one NAT shared across AZs (~$32/mo); set `false` for NAT per AZ in prod

After apply: `terraform output nat_gateway_public_ips`

## Security groups

Aligned with deployment.md §4.5:

| Direction | Port | Source / dest |
| --- | --- | --- |
| Execution host inbound | 9092 | EKS node SG → firecracker-host |
| Execution host inbound | 9091 | EKS node SG → scheduler |
| Execution host outbound | 443 | GitHub, agent APIs, Docker Hub |
| Execution host outbound | 9090 | Orchestrator NLB |
| EKS node egress | 9091–9092 | VPC CIDR → execution hosts |

## Remote state (recommended for teams)

Uncomment the `backend "s3"` block in `versions.tf` and create:

- S3 bucket with versioning + encryption
- DynamoDB table for state locking

## Cost notes

- `single_nat_gateway = true` (default) uses one NAT for dev/staging
- Set `execution_host_count = 0` to provision VPC + EKS only
- Firecracker hosts (`c7i.2xlarge`) are the largest cost driver

## Module layout

```text
infra/
├── main.tf
├── variables.tf
├── outputs.tf
├── providers.tf
├── versions.tf
├── terraform.tfvars.example
└── modules/
    ├── vpc/
    ├── eks/
    ├── execution-hosts/
    └── vault/
```
