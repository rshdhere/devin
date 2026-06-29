variable "aws_region" {
  description = "AWS region for the IAM stack."
  type        = string
  default     = "us-east-1"
}

variable "user_name" {
  description = "IAM user Terraform runs as."
  type        = string
  default     = "devin-infra"
}

variable "policy_name" {
  description = "Customer managed policy attached to the Terraform user."
  type        = string
  default     = "devin-infra-terraform"
}

variable "tags" {
  description = "Additional tags for IAM resources."
  type        = map(string)
  default     = {}
}

variable "github_repository" {
  description = "GitHub repo allowed to assume the IAM sync role (ORG/REPO)."
  type        = string
  default     = "rshdhere/devin"
}

variable "github_iam_sync_role_name" {
  description = "IAM role name GitHub Actions assumes via OIDC to publish policy versions."
  type        = string
  default     = "devin-github-iam-sync"
}

variable "github_deploy_role_name" {
  description = "IAM role name GitHub Actions assumes via OIDC to deploy execution host containers."
  type        = string
  default     = "devin-github-deploy"
}
