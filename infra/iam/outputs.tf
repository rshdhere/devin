output "user_name" {
  description = "IAM user name for Terraform."
  value       = aws_iam_user.devin_infra.name
}

output "user_arn" {
  description = "IAM user ARN for Terraform."
  value       = aws_iam_user.devin_infra.arn
}

output "policy_arn" {
  description = "Customer managed policy ARN synced from devin-infra-policy.json."
  value       = aws_iam_policy.terraform.arn
}

output "github_iam_sync_role_arn" {
  description = "Set as repository variable AWS_IAM_SYNC_ROLE_ARN for the sync-iam-policy workflow."
  value       = aws_iam_role.github_iam_sync.arn
}

output "github_deploy_role_arn" {
  description = "Set as repository variable AWS_DEPLOY_ROLE_ARN for the deploy-execution-hosts workflow."
  value       = aws_iam_role.github_deploy.arn
}

output "github_oidc_provider_arn" {
  description = "GitHub Actions OIDC provider ARN for this AWS account."
  value       = aws_iam_openid_connect_provider.github.arn
}
