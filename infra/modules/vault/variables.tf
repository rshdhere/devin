variable "name_prefix" {
  description = "Resource name prefix (project-environment)."
  type        = string
}

variable "cluster_name" {
  description = "EKS cluster name."
  type        = string
}

variable "aws_region" {
  description = "AWS region for KMS auto-unseal."
  type        = string
}

variable "oidc_provider_arn" {
  description = "EKS OIDC provider ARN for IRSA."
  type        = string
}

variable "oidc_provider_url" {
  description = "EKS OIDC issuer URL without https:// prefix."
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace for Vault."
  type        = string
  default     = "vault"
}

variable "helm_chart_version" {
  description = "HashiCorp Vault Helm chart version."
  type        = string
  default     = "0.29.1"
}

variable "ha_enabled" {
  description = "Run Vault in HA mode with integrated Raft storage."
  type        = bool
  default     = false
}

variable "ha_replicas" {
  description = "Number of Vault server replicas when HA is enabled."
  type        = number
  default     = 3
}

variable "storage_size" {
  description = "Persistent volume size per Vault pod."
  type        = string
  default     = "10Gi"
}

variable "storage_class" {
  description = "StorageClass for Vault PVCs (null = cluster default)."
  type        = string
  default     = null
}

variable "ingress_enabled" {
  description = "Expose Vault UI/API via Ingress."
  type        = bool
  default     = false
}

variable "ingress_host" {
  description = "Ingress hostname for Vault (internal DNS recommended)."
  type        = string
  default     = "vault.internal"
}

variable "ingress_class_name" {
  description = "Ingress class name."
  type        = string
  default     = "alb"
}

variable "injector_enabled" {
  description = "Enable Vault Agent Injector for pod-side secret injection."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to AWS resources."
  type        = map(string)
  default     = {}
}
