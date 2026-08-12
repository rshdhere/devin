resource "aws_lb" "scheduler" {
  count = local.scheduler_nlb_enabled ? 1 : 0

  name               = "${var.name_prefix}-scheduler"
  internal           = true
  load_balancer_type = "network"
  subnets            = var.private_subnet_ids

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-scheduler-nlb"
  })
}

resource "aws_lb_target_group" "scheduler" {
  count = local.scheduler_nlb_enabled ? 1 : 0

  name        = "${var.name_prefix}-sched-tg"
  port        = var.scheduler_port
  protocol    = "TCP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 10
    protocol            = "HTTP"
    path                = "/health"
    port                = "traffic-port"
    matcher             = "200"
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-scheduler-tg"
  })
}

resource "aws_lb_listener" "scheduler" {
  count = local.scheduler_nlb_enabled ? 1 : 0

  load_balancer_arn = aws_lb.scheduler[0].arn
  port              = var.scheduler_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.scheduler[0].arn
  }
}

resource "aws_lb_target_group_attachment" "scheduler" {
  for_each = local.scheduler_nlb_enabled ? var.execution_hosts : {}

  target_group_arn = aws_lb_target_group.scheduler[0].arn
  target_id        = each.value.instance_id
  port             = var.scheduler_port
}

resource "time_sleep" "wait_for_scheduler_nlb" {
  count = local.scheduler_nlb_enabled ? 1 : 0

  create_duration = "60s"

  depends_on = [aws_lb_listener.scheduler]
}

# Always present so downstream resources can depend on scheduler NLB readiness
# without referencing counted resources directly.
resource "null_resource" "scheduler_connectivity_ready" {
  triggers = {
    scheduler_url = local.worker_scheduler_url
    nlb_enabled   = tostring(local.scheduler_nlb_enabled)
    nlb_dns       = coalesce(local.scheduler_nlb_dns, "direct")
  }

  depends_on = [time_sleep.wait_for_scheduler_nlb]
}
