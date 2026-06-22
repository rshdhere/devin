output "namespace" {
  description = "Kubernetes namespace where Vault is deployed."
  value       = kubernetes_namespace.vault.metadata[0].name
}

output "kms_key_arn" {
  description = "KMS key ARN used for Vault auto-unseal."
  value       = aws_kms_key.vault.arn
}

output "kms_key_id" {
  description = "KMS key ID used for Vault auto-unseal."
  value       = aws_kms_key.vault.key_id
}

output "iam_role_arn" {
  description = "IAM role ARN for the Vault server service account."
  value       = aws_iam_role.vault.arn
}

output "service_account_name" {
  description = "Vault server Kubernetes service account name."
  value       = kubernetes_service_account.vault.metadata[0].name
}

output "helm_release_status" {
  description = "Vault Helm release status."
  value       = helm_release.vault.status
}

output "init_commands" {
  description = "Post-apply steps to initialize and bootstrap Vault."
  value       = <<-EOT
    # 1. Port-forward Vault API (or use ingress)
    kubectl -n ${kubernetes_namespace.vault.metadata[0].name} port-forward svc/vault 8200:8200

    # 2. Initialize (first time only — save unseal keys and root token securely)
    export VAULT_ADDR=http://127.0.0.1:8200
    vault operator init

    # 3. With KMS auto-unseal, Vault unseals automatically after init.
    # 4. Bootstrap auth, policies, and roles:
    export VAULT_TOKEN=<root-token>
    ./vault/bootstrap/kubernetes.sh --env prod --cluster ${var.cluster_name}
  EOT
}
