# Vault on EKS — AWS KMS auto-unseal, IRSA, Helm chart.
# Providers (kubernetes, helm) are configured in the root infra/ module.

data "aws_caller_identity" "current" {}

# --- KMS auto-unseal ---

resource "aws_kms_key" "vault" {
  description             = "Vault auto-unseal for ${var.cluster_name}"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-vault-unseal"
  })
}

resource "aws_kms_alias" "vault" {
  name          = "alias/${var.name_prefix}-vault-unseal"
  target_key_id = aws_kms_key.vault.key_id
}

# --- IRSA for Vault server ---

data "aws_iam_policy_document" "vault_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    actions = ["sts:AssumeRoleWithWebIdentity"]

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:sub"
      values   = ["system:serviceaccount:${var.namespace}:vault"]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "vault_kms" {
  statement {
    sid    = "VaultKMSUnseal"
    effect = "Allow"

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:DescribeKey",
    ]

    resources = [aws_kms_key.vault.arn]
  }
}

resource "aws_iam_role" "vault" {
  name               = "${var.name_prefix}-vault"
  assume_role_policy = data.aws_iam_policy_document.vault_assume_role.json

  tags = var.tags
}

resource "aws_iam_role_policy" "vault_kms" {
  name   = "vault-kms-unseal"
  role   = aws_iam_role.vault.id
  policy = data.aws_iam_policy_document.vault_kms.json
}

# --- Kubernetes namespace + service accounts ---

resource "kubernetes_namespace" "vault" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/name" = "vault"
    }
  }
}

resource "kubernetes_service_account" "vault" {
  metadata {
    name      = "vault"
    namespace = kubernetes_namespace.vault.metadata[0].name
    annotations = {
      "eks.amazonaws.com/role-arn" = aws_iam_role.vault.arn
    }
  }
}

resource "kubernetes_service_account" "vault_auth" {
  metadata {
    name      = "vault-auth"
    namespace = kubernetes_namespace.vault.metadata[0].name
  }
}

# --- Vault Helm release ---

resource "helm_release" "vault" {
  name       = "vault"
  repository = "https://helm.releases.hashicorp.com"
  chart      = "vault"
  version    = var.helm_chart_version
  namespace  = kubernetes_namespace.vault.metadata[0].name

  values = [
    yamlencode({
      global = {
        enabled    = true
        tlsDisable = true
      }

      server = {
        serviceAccount = {
          create = false
          name   = kubernetes_service_account.vault.metadata[0].name
        }

        ha = {
          enabled  = var.ha_enabled
          replicas = var.ha_replicas

          raft = {
            enabled   = var.ha_enabled
            setNodeId = true
            config = var.ha_enabled ? join("\n", [
              "ui = true",
              "listener \"tcp\" {",
              "  tls_disable = 1",
              "  address = \"[::]:8200\"",
              "  cluster_address = \"[::]:8201\"",
              "}",
              "storage \"raft\" {",
              "  path = \"/vault/data\"",
              "}",
              "seal \"awskms\" {",
              "  region = \"${var.aws_region}\"",
              "  kms_key_id = \"${aws_kms_key.vault.key_id}\"",
              "}",
              "service_registration \"kubernetes\" {}",
            ]) : ""
          }
        }

        standalone = {
          enabled = !var.ha_enabled
          config = join("\n", [
            "ui = true",
            "listener \"tcp\" {",
            "  tls_disable = 1",
            "  address = \"[::]:8200\"",
            "  cluster_address = \"[::]:8201\"",
            "}",
            "storage \"file\" {",
            "  path = \"/vault/data\"",
            "}",
            "seal \"awskms\" {",
            "  region = \"${var.aws_region}\"",
            "  kms_key_id = \"${aws_kms_key.vault.key_id}\"",
            "}",
          ])
        }

        dataStorage = {
          enabled = true
          size    = var.storage_size
        }

        ingress = {
          enabled          = var.ingress_enabled
          ingressClassName = var.ingress_class_name
          hosts = [
            {
              host  = var.ingress_host
              paths = [{ path = "/", pathType = "Prefix" }]
            }
          ]
        }

        extraEnvironmentVars = {
          AWS_REGION = var.aws_region
        }
      }

      injector = {
        enabled = var.injector_enabled
      }

      ui = {
        enabled     = true
        serviceType = "ClusterIP"
      }
    })
  ]

  depends_on = [
    kubernetes_service_account.vault,
    aws_iam_role_policy.vault_kms,
  ]
}
