variable "name_prefix" {
  description = "Prefix for platform connectivity resources."
  type        = string
}

variable "scheduler_url" {
  description = "Primary scheduler URL for devin-server (http://<host-ip>:9091)."
  type        = string
}

variable "manage_orchestrator_nlb" {
  description = "Create an internal NLB Service for devin-orchestrator in Kubernetes."
  type        = bool
  default     = true
}

variable "orchestrator_namespace" {
  description = "Namespace where devin-orchestrator runs."
  type        = string
  default     = "devin-system"
}

variable "orchestrator_service_name" {
  description = "Kubernetes Service name for the orchestrator internal NLB."
  type        = string
  default     = "devin-orchestrator-lb"
}

variable "orchestrator_selector" {
  description = "Pod selector labels for devin-orchestrator."
  type        = map(string)
  default = {
    app = "devin-orchestrator"
  }
}

variable "orchestrator_port" {
  description = "Orchestrator HTTP port exposed on the internal NLB."
  type        = number
  default     = 9090
}

variable "orchestrator_url_override" {
  description = "Optional fixed orchestrator URL for execution hosts. When null, use the internal NLB hostname when available."
  type        = string
  default     = null
}

variable "sync_scheduler_url_to_kubernetes" {
  description = "Merge SCHEDULER_URL into devin-server secrets via kubectl after apply."
  type        = bool
  default     = true
}

variable "server_secret_namespaces" {
  description = "Namespaces whose devin-server secret should receive SCHEDULER_URL."
  type        = list(string)
  default     = ["devin-app", "devin-staging"]
}

variable "manage_ssm_parameters" {
  description = "Write scheduler/orchestrator URLs to SSM. Requires ssm:PutParameter on the Terraform user."
  type        = bool
  default     = true
}

variable "firecracker_hosts_gitops_path" {
  description = "Optional path to write generated FirecrackerHost GitOps YAML."
  type        = string
  default     = null
}

variable "execution_hosts" {
  description = "Execution host map from the execution-hosts module output."
  type = map(object({
    name        = string
    private_ip  = string
    instance_id = string
    address     = string
    scheduler   = string
  }))
  default = {}
}

variable "tags" {
  description = "Tags applied to AWS resources."
  type        = map(string)
  default     = {}
}
