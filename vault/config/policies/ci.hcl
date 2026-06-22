# CI/CD — registry credentials for GitHub Actions.
path "secret/data/dev/ci" {
  capabilities = ["read"]
}

path "secret/data/staging/ci" {
  capabilities = ["read"]
}

path "secret/data/prod/ci" {
  capabilities = ["read"]
}
