# devin-infra IAM (GitOps)

The source of truth for Terraform permissions is **`devin-infra-policy.json`** in this directory.

This is **GitOps** (Infrastructure as Code): you change the JSON in git, merge to `main`, and automation syncs AWS to match.

## How sync works

```text
devin-infra-policy.json  →  merge to main  →  GitHub Actions (OIDC)
                                                      ↓
                              IAM role devin-github-iam-sync (short-lived creds)
                                                      ↓
                              iam:CreatePolicyVersion on devin-infra-terraform
```

| Layer | Role |
| --- | --- |
| `devin-infra-policy.json` | Version-controlled policy document |
| `github.tf` | GitHub OIDC provider + IAM role (no AWS keys in GitHub) |
| [sync-iam-policy](../../.github/workflows/sync-iam-policy.yaml) | Assumes role via OIDC, publishes policy version |

## One-time setup

**Use admin credentials** — not the `devin-infra` profile. That user cannot delete policies, tag itself, or manage OIDC.

```sh
unset AWS_PROFILE   # or: export AWS_PROFILE=your-admin-profile
aws sts get-caller-identity   # must NOT show user/devin-infra
```

### 1. Import existing user + policy (if created in console)

```sh
cd infra/iam
terraform init

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

terraform import aws_iam_user.devin_infra devin-infra
terraform import aws_iam_policy.terraform "arn:aws:iam::${ACCOUNT_ID}:policy/devin-infra-terraform"
terraform import aws_iam_user_policy_attachment.devin_infra "devin-infra/arn:aws:iam::${ACCOUNT_ID}:policy/devin-infra-terraform"
```

If your account **already** has a GitHub OIDC provider, import it (skip if import fails — `apply` will create it):

```sh
terraform import aws_iam_openid_connect_provider.github "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
```

### 2. Create OIDC role + provider

```sh
terraform apply
```

Note the output `github_iam_sync_role_arn`.

### 3. GitHub repository variable (not a secret)

Repository → Settings → Secrets and variables → Actions → **Variables**:

| Variable | Value |
| --- | --- |
| `AWS_IAM_SYNC_ROLE_ARN` | `terraform output -raw github_iam_sync_role_arn` — also used for execution host deploy |
| `AWS_DEPLOY_ROLE_ARN` | Optional — `terraform output -raw github_deploy_role_arn` (dedicated least-privilege role) |
| `AWS_REGION` | `ap-south-1` (region where execution hosts run) |
| `EXECUTION_HOST_INSTANCE_IDS` | Optional — comma-separated instance IDs (skips EC2 discover) |

After changing `github.tf`, run `terraform apply` in `infra/iam` so the sync role receives SSM/EC2 deploy permissions.

### 4. Verify

Merge a trivial change to `devin-infra-policy.json` (or run **sync-iam-policy** manually from `main`) and confirm the workflow succeeds.

## Security model

| Approach | Verdict |
| --- | --- |
| Long-lived access keys in GitHub Secrets | Avoid — keys can leak and are hard to rotate |
| **GitHub OIDC → IAM role** | Preferred — scoped to `repo:rshdhere/devin`, ~1h session, no stored secrets |

The sync role updates `devin-infra-terraform` **and** (after `terraform apply`) can deploy execution hosts via SSM.

The optional deploy role (`devin-github-deploy`) has the same SSM/EC2 permissions for least-privilege setups.

To tighten further, change `github_repository` in `variables.tf` or add a GitHub Environment with `token.actions.githubusercontent.com:sub` conditions.

## Day-to-day workflow

1. Edit `devin-infra-policy.json`.
2. Open a PR, review the diff.
3. Merge to `main` → GitHub Actions updates the policy in AWS.

Local preview (admin creds, after import):

```sh
cd infra/iam
terraform plan
```

## Why a separate stack?

Main infra under `infra/` runs as **`devin-infra`**. That user can manage VPC/EKS but not its own IAM policy. This bootstrap stack is applied once by an admin; CI uses the dedicated OIDC role.
