variable "name_prefix" {
  description = "Prefix for execution host resource names."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "vpc_cidr_block" {
  description = "VPC CIDR block."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for execution hosts."
  type        = list(string)
}

variable "eks_node_security_group_id" {
  description = "EKS node security group — allowed to reach firecracker and scheduler ports."
  type        = string
}

variable "host_count" {
  description = "Number of Firecracker execution hosts to provision."
  type        = number
  default     = 1
}

variable "instance_type" {
  description = "EC2 instance type with nested virt. c7i.2xlarge (16Gi) fits one 8Gi guest; use c7i.4xlarge+ for concurrent sandboxes."
  type        = string
  default     = "c7i.2xlarge"
}

variable "ami_id" {
  description = "AMI ID (Ubuntu 24.04 LTS recommended). Leave null to use latest Ubuntu 24.04."
  type        = string
  default     = null
}

variable "root_volume_size" {
  description = "Root EBS volume size in GiB for /var/lib/devin snapshots."
  type        = number
  default     = 200
}

variable "root_volume_type" {
  description = "Root EBS volume type."
  type        = string
  default     = "gp3"
}

variable "ssh_key_name" {
  description = "EC2 key pair name for SSH access (optional)."
  type        = string
  default     = null
}

variable "admin_ssh_cidr_blocks" {
  description = "CIDR blocks allowed SSH (port 22) to execution hosts."
  type        = list(string)
  default     = []
}

variable "container_registry" {
  description = "Docker Hub image prefix (e.g. docker.io/youruser)."
  type        = string
}

variable "image_tag" {
  description = "Container image tag for firecracker and scheduler."
  type        = string
  default     = "latest"
}

variable "tags" {
  description = "Tags applied to execution host resources."
  type        = map(string)
  default     = {}
}

variable "aws_region" {
  description = "AWS region for SSM parameter reads in bootstrap scripts."
  type        = string
}

variable "ssm_parameter_prefix" {
  description = "SSM parameter prefix for platform connectivity values (with leading slash)."
  type        = string
}

variable "enable_ssm_iam" {
  description = "Create IAM instance profile for SSM platform config sync."
  type        = bool
  default     = true
}

variable "task_queue_arn" {
  description = "SQS task queue ARN for scheduler job processing."
  type        = string
  default     = ""
}

variable "enable_task_queue" {
  description = "Grant SQS permissions on the execution host IAM role."
  type        = bool
  default     = false
}
