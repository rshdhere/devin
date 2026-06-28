data "aws_ami" "ubuntu" {
  count = var.ami_id == null ? 1 : 0

  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  ami_id = coalesce(var.ami_id, try(data.aws_ami.ubuntu[0].id, null))
  hosts  = { for i in range(var.host_count) : format("fc-%02d", i + 1) => i }
}

resource "aws_security_group" "execution_host" {
  name_prefix = "${var.name_prefix}-fc-host-"
  description = "Firecracker execution host (deployment.md section 4.5)"
  vpc_id      = var.vpc_id

  ingress {
    description     = "orchestrator to firecracker-host API"
    from_port       = 9092
    to_port         = 9092
    protocol        = "tcp"
    security_groups = [var.eks_node_security_group_id]
  }

  ingress {
    description     = "server to scheduler"
    from_port       = 9091
    to_port         = 9091
    protocol        = "tcp"
    security_groups = [var.eks_node_security_group_id]
  }

  ingress {
    description = "orchestrator and server from VPC (fallback)"
    from_port   = 9091
    to_port     = 9092
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr_block]
  }

  dynamic "ingress" {
    for_each = length(var.admin_ssh_cidr_blocks) > 0 ? [1] : []

    content {
      description = "SSH from admin / bastion"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.admin_ssh_cidr_blocks
    }
  }

  egress {
    description = "HTTP for apt and package mirrors"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS resolution"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "HTTPS for GitHub, agent APIs, Docker Hub"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Orchestrator callback on internal NLB / cluster"
    from_port   = 9090
    to_port     = 9090
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr_block]
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-execution-host-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_instance" "execution_host" {
  for_each = local.hosts

  ami                    = local.ami_id
  instance_type          = var.instance_type
  subnet_id              = var.private_subnet_ids[each.value % length(var.private_subnet_ids)]
  vpc_security_group_ids = [aws_security_group.execution_host.id]
  key_name               = var.ssh_key_name
  iam_instance_profile   = var.enable_ssm_iam ? aws_iam_instance_profile.execution_host[0].name : null

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = var.root_volume_type
    encrypted   = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  user_data = base64encode(templatefile("${path.module}/userdata.sh.tftpl", {
    host_name            = "${var.name_prefix}-${each.key}"
    container_registry     = var.container_registry
    image_tag              = var.image_tag
    aws_region             = var.aws_region
    ssm_parameter_prefix   = var.ssm_parameter_prefix
  }))

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-${each.key}"
    Role = "firecracker-execution-host"
  })

  lifecycle {
    ignore_changes = [ami]
  }
}
