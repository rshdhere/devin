terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    kubernetes = {
      source = "hashicorp/kubernetes"
    }
    time = {
      source = "hashicorp/time"
    }
    null = {
      source = "hashicorp/null"
    }
  }
}

locals {
  ssm_prefix = "/${var.name_prefix}/platform"

  orchestrator_nlb_hostname = var.manage_orchestrator_nlb ? try(
    one([
      for ing in kubernetes_service_v1.orchestrator_nlb[0].status[0].load_balancer[0].ingress :
      coalesce(ing.hostname, ing.ip)
    ]),
    null,
  ) : null

  orchestrator_url = coalesce(
    var.orchestrator_url_override,
    local.orchestrator_nlb_hostname != null ? "http://${local.orchestrator_nlb_hostname}:${var.orchestrator_port}" : null,
  )
}

data "kubernetes_namespace_v1" "orchestrator" {
  count = var.manage_orchestrator_nlb ? 1 : 0

  metadata {
    name = var.orchestrator_namespace
  }
}

resource "kubernetes_service_v1" "orchestrator_nlb" {
  count = var.manage_orchestrator_nlb ? 1 : 0

  metadata {
    name      = var.orchestrator_service_name
    namespace = var.orchestrator_namespace
    annotations = {
      "service.beta.kubernetes.io/aws-load-balancer-type"                              = "nlb"
      "service.beta.kubernetes.io/aws-load-balancer-internal"                          = "true"
      "service.beta.kubernetes.io/aws-load-balancer-scheme"                            = "internal"
      "service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled" = "true"
    }
  }

  spec {
    type = "LoadBalancer"

    port {
      port        = var.orchestrator_port
      target_port = var.orchestrator_port
      protocol    = "TCP"
    }

    selector = var.orchestrator_selector
  }

  depends_on = [data.kubernetes_namespace_v1.orchestrator]

  lifecycle {
    ignore_changes = [
      metadata[0].annotations["service.beta.kubernetes.io/aws-load-balancer-eip-allocations"],
    ]
  }
}

resource "time_sleep" "wait_for_orchestrator_nlb" {
  count = var.manage_orchestrator_nlb ? 1 : 0

  create_duration = "90s"

  depends_on = [kubernetes_service_v1.orchestrator_nlb]
}

resource "aws_ssm_parameter" "scheduler_url" {
  count = var.manage_ssm_parameters ? 1 : 0

  name  = "${local.ssm_prefix}/scheduler_url"
  type  = "String"
  value = var.scheduler_url

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-scheduler-url"
  })
}

resource "aws_ssm_parameter" "orchestrator_url" {
  count = var.manage_ssm_parameters ? 1 : 0

  name  = "${local.ssm_prefix}/orchestrator_url"
  type  = "String"
  value = coalesce(local.orchestrator_url, "http://REPLACE_AFTER_ORCHESTRATOR_NLB:9090")

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-orchestrator-url"
  })

  depends_on = [time_sleep.wait_for_orchestrator_nlb]
}

resource "null_resource" "sync_scheduler_url" {
  count = var.sync_scheduler_url_to_kubernetes && var.scheduler_url != "" ? 1 : 0

  triggers = {
    scheduler_url = var.scheduler_url
    namespaces    = join(",", var.server_secret_namespaces)
  }

  provisioner "local-exec" {
    command     = "${path.module}/../../scripts/patch-server-scheduler-url.sh"
    interpreter = ["bash", "-c"]
    environment = {
      SCHEDULER_URL = var.scheduler_url
      NAMESPACES    = join(" ", var.server_secret_namespaces)
    }
  }
}

resource "local_file" "firecracker_hosts_gitops" {
  count = var.firecracker_hosts_gitops_path != null && length(var.execution_hosts) > 0 ? 1 : 0

  filename = var.firecracker_hosts_gitops_path
  content = templatefile("${path.module}/templates/firecracker-hosts.yaml.tftpl", {
    hosts = var.execution_hosts
  })
}
