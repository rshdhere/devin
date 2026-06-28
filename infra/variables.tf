variable "aws_region" {
  description = "AWS region (align with Neon project region, e.g. us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)."
  type        = string
  default     = "dev"
}

variable "project_name" {
  description = "Project name used in resource naming."
  type        = string
  default     = "devin"
}

variable "cluster_name" {
  description = "EKS cluster name."
  type        = string
  default     = "devin"
}

variable "tags" {
  description = "Additional tags for all resources."
  type        = map(string)
  default     = {}
}

# --- VPC ---

variable "vpc_cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones (2 or 3 recommended)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be between 2 and 3."
  }
}

variable "single_nat_gateway" {
  description = "Use one NAT gateway for all AZs (cheaper for dev)."
  type        = bool
  default     = true
}

variable "enable_nat_gateway" {
  description = "Provision NAT gateway(s) for outbound internet from private subnets (Docker Hub, Neon, GitHub)."
  type        = bool
  default     = true
}

# --- EKS ---

variable "cluster_version" {
  description = "Kubernetes Version"
  type        = string
  default     = "1.34"
}

variable "eks_node_instance_types" {
  description = "EKS worker instance types (control-plane workloads only — not Firecracker)."
  type        = list(string)
  default     = ["m6i.large"]
}

variable "eks_node_desired_size" {
  type    = number
  default = 2
}

variable "eks_node_min_size" {
  type    = number
  default = 1
}

variable "eks_node_max_size" {
  type    = number
  default = 4
}

variable "eks_node_disk_size" {
  type    = number
  default = 50
}

variable "eks_endpoint_public_access" {
  description = "Expose the Kubernetes API publicly (restrict with eks_endpoint_public_access_cidrs)."
  type        = bool
  default     = true
}

variable "eks_endpoint_public_access_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

# --- Firecracker execution hosts (Path B) ---

variable "execution_host_count" {
  description = "Number of EC2 Firecracker execution hosts (0 to skip)."
  type        = number
  default     = 1
}

variable "execution_host_instance_type" {
  description = "EC2 instance type with nested virtualization support (c7i.2xlarge recommended; c5.metal for bare metal)."
  type        = string
  default     = "c7i.2xlarge"
}

variable "execution_host_enable_nested_virtualization" {
  description = "Set NestedVirtualization=enabled on execution hosts (required for Firecracker /dev/kvm)."
  type        = bool
  default     = true
}

variable "execution_host_root_volume_size" {
  description = "Root disk size for /var/lib/devin snapshots."
  type        = number
  default     = 200
}

variable "execution_host_ssh_key_name" {
  description = "EC2 key pair for SSH to execution hosts."
  type        = string
  default     = null
}

variable "execution_host_admin_ssh_cidr_blocks" {
  description = "Admin CIDRs allowed SSH to execution hosts."
  type        = list(string)
  default     = []
}

variable "container_registry" {
  description = "Docker Hub image prefix (e.g. docker.io/youruser or youruser)."
  type        = string
}

variable "container_image_tag" {
  description = "Image tag for firecracker-host and scheduler containers."
  type        = string
  default     = "latest"
}

# --- Platform connectivity (Path B) ---

variable "manage_orchestrator_nlb" {
  description = "Create an internal NLB Service for devin-orchestrator (Path B execution hosts)."
  type        = bool
  default     = true
}

variable "orchestrator_namespace" {
  description = "Namespace where devin-orchestrator runs."
  type        = string
  default     = "devin-system"
}

variable "orchestrator_url_override" {
  description = "Optional fixed orchestrator URL for execution host schedulers. Leave null to use the internal NLB."
  type        = string
  default     = null
}

variable "sync_scheduler_url_to_kubernetes" {
  description = "Patch SCHEDULER_URL into devin-server secrets after apply (requires kubectl)."
  type        = bool
  default     = true
}

variable "server_secret_namespaces" {
  description = "Namespaces whose devin-server secret receives SCHEDULER_URL."
  type        = list(string)
  default     = ["devin-app", "devin-staging"]
}

variable "sync_execution_host_config" {
  description = "Run SSM bootstrap on execution hosts after apply to start scheduler with SSM URLs."
  type        = bool
  default     = true
}

variable "generate_firecracker_hosts_gitops" {
  description = "Write infra/generated/firecracker-hosts.yaml from Terraform execution host IPs."
  type        = bool
  default     = true
}

variable "manage_ssm_parameters" {
  description = "Write platform URLs to SSM (requires ssm:PutParameter)."
  type        = bool
  default     = true
}

variable "enable_ssm_iam" {
  description = "Attach IAM instance profile for SSM on execution hosts (Session Manager + platform config). Requires iam:CreateInstanceProfile on the Terraform user."
  type        = bool
  default     = true
}

# --- HashiCorp Vault ---

variable "enable_vault" {
  description = "Deploy HashiCorp Vault on EKS with AWS KMS auto-unseal."
  type        = bool
  default     = false
}

variable "vault_namespace" {
  description = "Kubernetes namespace for Vault."
  type        = string
  default     = "vault"
}

variable "vault_ha_enabled" {
  description = "Run Vault in HA mode with integrated Raft (recommended for prod)."
  type        = bool
  default     = false
}

variable "vault_ha_replicas" {
  description = "Vault server replicas when HA is enabled."
  type        = number
  default     = 3
}

variable "vault_ingress_enabled" {
  description = "Expose Vault via Ingress (use internal hostname + TLS in GitOps)."
  type        = bool
  default     = false
}

variable "vault_ingress_host" {
  description = "Ingress hostname for Vault API/UI."
  type        = string
  default     = "vault.internal"
}

variable "vault_injector_enabled" {
  description = "Enable Vault Agent Injector for pod-side secret injection."
  type        = bool
  default     = true
}
