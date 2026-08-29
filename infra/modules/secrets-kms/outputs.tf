output "kms_key_id" {
  description = "KMS key ID for application secret envelope encryption."
  value       = aws_kms_key.secrets.key_id
}

output "kms_key_arn" {
  description = "KMS key ARN for application secret envelope encryption."
  value       = aws_kms_key.secrets.arn
}

output "kms_key_alias" {
  description = "KMS alias for application secret envelope encryption."
  value       = aws_kms_alias.secrets.name
}

output "server_irsa_role_arn" {
  description = "IRSA role ARN for devin-server secrets KMS access."
  value       = try(aws_iam_role.server_secrets_kms[0].arn, null)
}

output "brain_irsa_role_arn" {
  description = "IRSA role ARN for devin-brain secrets KMS access."
  value       = try(aws_iam_role.brain_secrets_kms[0].arn, null)
}
