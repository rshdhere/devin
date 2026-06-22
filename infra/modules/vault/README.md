# Terraform module — HashiCorp Vault on EKS

Deploys Vault into the EKS cluster created by the parent `infra/` stack.

## Resources

| Resource | Purpose |
| --- | --- |
| `aws_kms_key` | Auto-unseal (no manual unseal keys in steady state) |
| `aws_iam_role` + IRSA | Vault server KMS access |
| `helm_release` (hashicorp/vault) | Vault server + optional Agent Injector |
| `kubernetes_namespace` | Default: `vault` |

## Usage

```hcl
module "vault" {
  source = "./modules/vault"

  name_prefix       = "devin-prod"
  cluster_name      = "devin"
  aws_region        = "us-east-1"
  oidc_provider_arn = module.eks.oidc_provider_arn
  oidc_provider_url = module.eks.oidc_provider_url

  ha_enabled       = true
  ha_replicas      = 3
  ingress_enabled  = true
  ingress_host     = "vault.internal.example.com"
  injector_enabled = true
}
```

Parent stack enables this with `enable_vault = true` in `terraform.tfvars`.

## Post-apply

Run `terraform output vault_init_commands` for initialization and `./vault/bootstrap/kubernetes.sh` for auth setup. See `vault/README.md`.

## HA vs standalone

| Mode | `ha_enabled` | Storage | When |
| --- | --- | --- | --- |
| Standalone | `false` | file (single PVC) | Dev / staging |
| HA Raft | `true` | integrated raft (3 PVCs) | Production |

Both modes use AWS KMS auto-unseal.
