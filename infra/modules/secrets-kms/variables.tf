variable "name_prefix" {
  type        = string
  description = "Resource name prefix."
}

variable "aws_region" {
  type        = string
  description = "AWS region."
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to created resources."
  default     = {}
}

variable "eks_oidc_provider_arn" {
  type        = string
  description = "EKS OIDC provider ARN for IRSA."
  default     = ""
}

variable "eks_oidc_provider_url" {
  type        = string
  description = "EKS OIDC issuer URL without https:// prefix."
  default     = ""
}

variable "server_service_account_namespace" {
  type        = string
  description = "Kubernetes namespace for devin-server."
  default     = "devin-app"
}

variable "brain_service_account_namespace" {
  type        = string
  description = "Kubernetes namespace for devin-brain."
  default     = "devin-app"
}

variable "server_service_account_name" {
  type    = string
  default = "devin-server"
}

variable "brain_service_account_name" {
  type    = string
  default = "devin-brain"
}

variable "execution_host_role_arn" {
  type        = string
  description = "IAM role ARN attached to EC2 execution hosts."
  default     = ""
}

variable "enable_irsa" {
  type        = bool
  description = "Create IRSA roles for EKS workloads."
  default     = true
}

variable "enable_execution_host_access" {
  type        = bool
  description = "Allow execution host IAM role to use the secrets key."
  default     = true
}
