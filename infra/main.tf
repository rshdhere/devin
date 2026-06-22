module "vpc" {
  source = "./modules/vpc"

  name                 = local.name_prefix
  vpc_cidr             = var.vpc_cidr
  azs                  = local.azs
  private_subnet_cidrs = local.private_subnet_cidrs
  public_subnet_cidrs  = local.public_subnet_cidrs
  enable_nat_gateway   = var.enable_nat_gateway
  single_nat_gateway   = var.single_nat_gateway
  cluster_name         = var.cluster_name
  tags                 = var.tags
}

module "eks" {
  source = "./modules/eks"

  cluster_name                 = var.cluster_name
  cluster_version              = var.cluster_version
  vpc_id                       = module.vpc.vpc_id
  vpc_cidr_block               = module.vpc.vpc_cidr_block
  private_subnet_ids           = module.vpc.private_subnet_ids
  node_instance_types          = var.eks_node_instance_types
  node_desired_size            = var.eks_node_desired_size
  node_min_size                = var.eks_node_min_size
  node_max_size                = var.eks_node_max_size
  node_disk_size               = var.eks_node_disk_size
  endpoint_public_access       = var.eks_endpoint_public_access
  endpoint_public_access_cidrs = var.eks_endpoint_public_access_cidrs
  tags                         = var.tags

  depends_on = [module.vpc]
}

module "execution_hosts" {
  source = "./modules/execution-hosts"
  count  = var.execution_host_count > 0 ? 1 : 0

  name_prefix                = local.name_prefix
  vpc_id                     = module.vpc.vpc_id
  vpc_cidr_block             = module.vpc.vpc_cidr_block
  private_subnet_ids         = module.vpc.private_subnet_ids
  eks_node_security_group_id = module.eks.node_security_group_id
  host_count                 = var.execution_host_count
  instance_type              = var.execution_host_instance_type
  root_volume_size           = var.execution_host_root_volume_size
  ssh_key_name               = var.execution_host_ssh_key_name
  admin_ssh_cidr_blocks      = var.execution_host_admin_ssh_cidr_blocks
  container_registry         = var.container_registry
  image_tag                  = var.container_image_tag
  tags                       = var.tags

  depends_on = [module.eks]
}

# --- HashiCorp Vault (optional) ---

module "vault" {
  source = "./modules/vault"
  count  = var.enable_vault ? 1 : 0

  name_prefix         = local.name_prefix
  cluster_name        = var.cluster_name
  aws_region          = var.aws_region
  oidc_provider_arn   = module.eks.oidc_provider_arn
  oidc_provider_url   = module.eks.oidc_provider_url
  namespace           = var.vault_namespace
  ha_enabled          = var.vault_ha_enabled
  ha_replicas         = var.vault_ha_replicas
  ingress_enabled     = var.vault_ingress_enabled
  ingress_host        = var.vault_ingress_host
  injector_enabled    = var.vault_injector_enabled
  tags                = var.tags

  depends_on = [module.eks]
}
