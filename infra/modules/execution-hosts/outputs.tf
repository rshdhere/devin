output "security_group_id" {
  description = "Security group ID for Firecracker execution hosts."
  value       = aws_security_group.execution_host.id
}

output "instance_ids" {
  description = "Map of host key to EC2 instance ID."
  value       = { for k, v in aws_instance.execution_host : k => v.id }
}

output "private_ips" {
  description = "Map of host key to private IP — use in FirecrackerHost CRs (infra/deployment.md section 4.3)."
  value       = { for k, v in aws_instance.execution_host : k => v.private_ip }
}

output "hosts" {
  description = "Execution host details for GitOps firecracker-hosts.yaml."
  value = {
    for k, v in aws_instance.execution_host : k => {
      name        = "${var.name_prefix}-${k}"
      private_ip  = v.private_ip
      instance_id = v.id
      address     = "http://${v.private_ip}:9092"
      scheduler   = "http://${v.private_ip}:9091"
    }
  }
}

output "iam_role_arn" {
  description = "IAM role ARN attached to execution hosts (null when SSM IAM disabled)."
  value       = try(aws_iam_role.execution_host[0].arn, null)
}
