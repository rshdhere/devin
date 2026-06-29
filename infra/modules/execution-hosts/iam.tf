resource "aws_iam_role" "execution_host" {
  count = var.enable_ssm_iam ? 1 : 0

  name_prefix = "${var.name_prefix}-fc-host-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-execution-host-role"
  })
}

resource "aws_iam_role_policy" "execution_host_ssm" {
  count = var.enable_ssm_iam ? 1 : 0

  name_prefix = "${var.name_prefix}-fc-host-ssm-"
  role        = aws_iam_role.execution_host[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
        ]
        Resource = [
          "arn:aws:ssm:*:*:parameter${var.ssm_parameter_prefix}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "ec2messages:AcknowledgeMessage",
          "ec2messages:DeleteMessage",
          "ec2messages:FailMessage",
          "ec2messages:GetEndpoint",
          "ec2messages:GetMessages",
          "ec2messages:SendReply",
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "execution_host_ssm_core" {
  count = var.enable_ssm_iam ? 1 : 0

  role       = aws_iam_role.execution_host[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "execution_host" {
  count = var.enable_ssm_iam ? 1 : 0

  name_prefix = "${var.name_prefix}-fc-host-"
  role        = aws_iam_role.execution_host[0].name
}

resource "aws_iam_role_policy" "execution_host_sqs" {
  count = var.enable_ssm_iam && var.enable_task_queue ? 1 : 0

  name_prefix = "${var.name_prefix}-fc-host-sqs-"
  role        = aws_iam_role.execution_host[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ChangeMessageVisibility",
      ]
      Resource = var.task_queue_arn
    }]
  })
}
