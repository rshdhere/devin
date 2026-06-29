data "aws_caller_identity" "current" {}

# GitHub Actions OIDC — one provider per AWS account (import if it already exists).
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4ace81436421ea4f4bb41b676e69d35415"]
}

data "aws_iam_policy_document" "github_iam_sync_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
    }
  }
}

resource "aws_iam_role" "github_iam_sync" {
  name               = var.github_iam_sync_role_name
  assume_role_policy = data.aws_iam_policy_document.github_iam_sync_assume_role.json

  tags = merge(var.tags, {
    Project   = "devin"
    ManagedBy = "terraform"
    Purpose   = "github-actions-iam-policy-sync"
  })
}

data "aws_iam_policy_document" "github_iam_sync" {
  statement {
    sid    = "SyncDevinInfraTerraformPolicy"
    effect = "Allow"
    actions = [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions"
    ]
    resources = [
      aws_iam_policy.terraform.arn,
      "${aws_iam_policy.terraform.arn}:*"
    ]
  }
}

resource "aws_iam_role_policy" "github_iam_sync" {
  name   = "sync-devin-infra-terraform-policy"
  role   = aws_iam_role.github_iam_sync.id
  policy = data.aws_iam_policy_document.github_iam_sync.json
}

resource "aws_iam_role_policy" "github_iam_sync_deploy" {
  name   = "deploy-execution-hosts"
  role   = aws_iam_role.github_iam_sync.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

# Execution host deploy — dedicated role (optional; sync role also has deploy perms).
data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid    = "DiscoverExecutionHosts"
    effect = "Allow"
    actions = [
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceStatus",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "SSMDeployExecutionHosts"
    effect = "Allow"
    actions = [
      "ssm:SendCommand",
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:DescribeInstanceInformation",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = var.github_deploy_role_name
  assume_role_policy = data.aws_iam_policy_document.github_iam_sync_assume_role.json

  tags = merge(var.tags, {
    Project   = "devin"
    ManagedBy = "terraform"
    Purpose   = "github-actions-execution-host-deploy"
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy-execution-hosts"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
