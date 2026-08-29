data "aws_caller_identity" "current" {}

resource "aws_kms_key" "secrets" {
  description             = "${var.name_prefix} application secrets envelope encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-secrets-kms"
  })
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name_prefix}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

data "aws_iam_policy_document" "secrets_key" {
  statement {
    sid    = "EnableRootPermissions"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = var.execution_host_role_arn != "" && var.enable_execution_host_access ? [1] : []
    content {
      sid    = "ExecutionHostSecretsAccess"
      effect = "Allow"
      principals {
        type        = "AWS"
        identifiers = [var.execution_host_role_arn]
      }
      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_irsa && length(aws_iam_role.server_secrets_kms) > 0 ? [1] : []
    content {
      sid    = "ServerIrsaSecretsAccess"
      effect = "Allow"
      principals {
        type        = "AWS"
        identifiers = [aws_iam_role.server_secrets_kms[0].arn]
      }
      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey",
      ]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_irsa && length(aws_iam_role.brain_secrets_kms) > 0 ? [1] : []
    content {
      sid    = "BrainIrsaSecretsAccess"
      effect = "Allow"
      principals {
        type        = "AWS"
        identifiers = [aws_iam_role.brain_secrets_kms[0].arn]
      }
      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_kms_key_policy" "secrets" {
  key_id = aws_kms_key.secrets.id
  policy = data.aws_iam_policy_document.secrets_key.json

  depends_on = [
    aws_iam_role.server_secrets_kms,
    aws_iam_role.brain_secrets_kms,
  ]
}

data "aws_iam_policy_document" "workload_secrets_kms" {
  statement {
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_policy" "server_secrets_kms" {
  count = var.enable_irsa && var.eks_oidc_provider_arn != "" ? 1 : 0

  name_prefix = "${var.name_prefix}-server-secrets-kms-"
  description = "Allow devin-server to envelope-encrypt OAuth tokens"
  policy      = data.aws_iam_policy_document.workload_secrets_kms.json

  tags = var.tags
}

resource "aws_iam_role" "server_secrets_kms" {
  count = var.enable_irsa && var.eks_oidc_provider_arn != "" ? 1 : 0

  name_prefix = "${var.name_prefix}-server-secrets-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = var.eks_oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${var.eks_oidc_provider_url}:aud" = "sts.amazonaws.com"
          "${var.eks_oidc_provider_url}:sub" = "system:serviceaccount:${var.server_service_account_namespace}:${var.server_service_account_name}"
        }
      }
    }]
  })

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-server-secrets-kms"
  })
}

resource "aws_iam_role_policy_attachment" "server_secrets_kms" {
  count = length(aws_iam_role.server_secrets_kms)

  role       = aws_iam_role.server_secrets_kms[0].name
  policy_arn = aws_iam_policy.server_secrets_kms[0].arn
}

resource "aws_iam_policy" "brain_secrets_kms" {
  count = var.enable_irsa && var.eks_oidc_provider_arn != "" ? 1 : 0

  name_prefix = "${var.name_prefix}-brain-secrets-kms-"
  description = "Allow devin-brain to envelope-encrypt task tokens"
  policy      = data.aws_iam_policy_document.workload_secrets_kms.json

  tags = var.tags
}

resource "aws_iam_role" "brain_secrets_kms" {
  count = var.enable_irsa && var.eks_oidc_provider_arn != "" ? 1 : 0

  name_prefix = "${var.name_prefix}-brain-secrets-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = var.eks_oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${var.eks_oidc_provider_url}:aud" = "sts.amazonaws.com"
          "${var.eks_oidc_provider_url}:sub" = "system:serviceaccount:${var.brain_service_account_namespace}:${var.brain_service_account_name}"
        }
      }
    }]
  })

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-brain-secrets-kms"
  })
}

resource "aws_iam_role_policy_attachment" "brain_secrets_kms" {
  count = length(aws_iam_role.brain_secrets_kms)

  role       = aws_iam_role.brain_secrets_kms[0].name
  policy_arn = aws_iam_policy.brain_secrets_kms[0].arn
}
