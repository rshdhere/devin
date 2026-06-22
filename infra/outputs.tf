output "vpc_id" {
  description = "VPC ID."
  value       = module.vpc.vpc_id
}

output "vpc_cidr_block" {
  description = "VPC CIDR block."
  value       = module.vpc.vpc_cidr_block
}

output "private_subnet_ids" {
  description = "Private subnet IDs."
  value       = module.vpc.private_subnet_ids
}

output "public_subnet_ids" {
  description = "Public subnet IDs."
  value       = module.vpc.public_subnet_ids
}

output "internet_gateway_id" {
  description = "VPC internet gateway ID."
  value       = module.vpc.internet_gateway_id
}

output "public_route_table_id" {
  description = "Public route table ID (0.0.0.0/0 → internet gateway)."
  value       = module.vpc.public_route_table_id
}

output "private_route_table_ids" {
  description = "Private route table IDs (0.0.0.0/0 → NAT gateway when enabled)."
  value       = module.vpc.private_route_table_ids
}

output "nat_gateway_ids" {
  description = "NAT gateway IDs for outbound traffic from private subnets."
  value       = module.vpc.nat_gateway_ids
}

output "nat_gateway_public_ips" {
  description = "Public IPs of NAT gateway elastic IPs."
  value       = module.vpc.nat_gateway_public_ips
}

output "container_registry" {
  description = "Docker Hub prefix used for container images (configure imagePullSecrets in GitOps for private repos)."
  value       = var.container_registry
}

output "eks_cluster_name" {
  description = "EKS cluster name."
  value       = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = module.eks.cluster_endpoint
}

output "eks_cluster_certificate_authority_data" {
  description = "CA data for kubectl configuration."
  value       = module.eks.cluster_certificate_authority_data
  sensitive   = true
}

output "eks_oidc_provider_arn" {
  description = "OIDC provider ARN for IRSA (install AWS Load Balancer Controller)."
  value       = module.eks.oidc_provider_arn
}

output "eks_node_security_group_id" {
  description = "EKS node security group ID."
  value       = module.eks.node_security_group_id
}

output "execution_hosts" {
  description = "Firecracker execution host details for GitOps FirecrackerHost CRs."
  value       = try(module.execution_hosts[0].hosts, {})
}

output "configure_kubectl" {
  description = "Command to configure kubectl for the EKS cluster."
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${module.eks.cluster_name}"
}

output "vault_namespace" {
  description = "Kubernetes namespace where Vault is deployed (null if disabled)."
  value       = try(module.vault[0].namespace, null)
}

output "vault_kms_key_arn" {
  description = "KMS key ARN for Vault auto-unseal (null if disabled)."
  value       = try(module.vault[0].kms_key_arn, null)
}

output "vault_init_commands" {
  description = "Post-apply Vault initialization and bootstrap steps."
  value       = try(module.vault[0].init_commands, null)
  sensitive   = true
}
