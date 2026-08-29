# Secrets KMS

Dedicated AWS KMS key for envelope-encrypting OAuth tokens and per-task GitHub tokens at rest and in brain→worker transit.

## Resources

| Resource | Purpose |
| --- | --- |
| `aws_kms_key.secrets` | Application secrets envelope encryption |
| `aws_kms_alias.secrets` | `alias/<name_prefix>-secrets` |
| `aws_iam_role.server_secrets_kms` | IRSA for `devin-server` |
| `aws_iam_role.brain_secrets_kms` | IRSA for `devin-brain` |

Execution hosts receive `kms:Decrypt` and `kms:GenerateDataKey` via the KMS key policy when `execution_host_role_arn` is set.

## Usage

Parent stack enables this module automatically. After apply:

```sh
terraform output -raw secrets_kms_key_id
```

Set `SECRETS_KMS_KEY_ID` on API server, brain, and scheduler workloads. The key ID is also published to SSM at `/<name_prefix>/platform/secrets_kms_key_id` when `manage_ssm_parameters = true`.

Annotate Kubernetes service accounts in GitOps:

- `devin-server` → `terraform output -raw server_secrets_irsa_role_arn`
- `devin-brain` → `terraform output -raw brain_secrets_irsa_role_arn`

Local development uses `LOCAL_SECRETS_KEY` (32-byte base64) instead of KMS.
