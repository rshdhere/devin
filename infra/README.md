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

**Do not** run Firecracker on EKS workers. Execution hosts are dedicated EC2 instances with `/dev/kvm`.

## Prerequisites

- Terraform >= 1.6
- AWS CLI configured (`aws sts get-caller-identity`)
- IAM permissions for VPC, EKS, EC2, IAM
- Docker Hub images pushed (`<container_registry>/devin-server`, etc.)

## Quick start

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars (region, container_registry, SSH key, admin CIDRs)

terraform init
terraform plan
terraform apply
```

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

## Outputs

After `terraform apply`, note:

- `container_registry` — Docker Hub prefix for image references
- `execution_hosts` — private IPs for GitOps `FirecrackerHost` CRs
- `eks_oidc_provider_arn` — install [AWS Load Balancer Controller](https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html) via IRSA in GitOps

## Post-apply checklist (deployment.md)

1. **Neon** — create Postgres project; set `DATABASE_URL` in GitOps secrets
2. **Build & push images** to Docker Hub
3. **Execution hosts** — SSH in, `docker login` if needed, build snapshots (§2), copy CNI config, set `ORCHESTRATOR_URL`, enable systemd units
4. **GitOps** — sync `overlays/<env>-external`; register `FirecrackerHost` CRs with `terraform output execution_hosts`
5. **Ingress** — AWS Load Balancer Controller + ACM in GitOps
6. **Orchestrator NLB** — internal NLB on `:9090` for execution host schedulers
7. **Vault** (optional) — `enable_vault = true` in Terraform; see [vault/README.md](../vault/README.md)

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
