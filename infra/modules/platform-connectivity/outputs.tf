output "scheduler_url" {
  description = "Primary scheduler URL wired into devin-server."
  value       = var.scheduler_url
}

output "orchestrator_url" {
  description = "Orchestrator URL published for execution host schedulers."
  value       = local.orchestrator_url
}

output "orchestrator_nlb_hostname" {
  description = "Internal NLB hostname for devin-orchestrator (null until AWS provisions the load balancer)."
  value       = local.orchestrator_nlb_hostname
}

output "ssm_scheduler_url_parameter" {
  description = "SSM parameter name containing scheduler_url."
  value       = try(aws_ssm_parameter.scheduler_url[0].name, null)
}

output "ssm_orchestrator_url_parameter" {
  description = "SSM parameter name containing orchestrator_url."
  value       = try(aws_ssm_parameter.orchestrator_url[0].name, null)
}

output "firecracker_hosts_gitops_path" {
  description = "Generated FirecrackerHost GitOps YAML path (null when not generated)."
  value       = try(local_file.firecracker_hosts_gitops[0].filename, null)
}
