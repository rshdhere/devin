# Scheduler — agent API keys and orchestrator connection (EC2 execution hosts).
path "secret/data/dev/scheduler" {
  capabilities = ["read"]
}

path "secret/data/staging/scheduler" {
  capabilities = ["read"]
}

path "secret/data/prod/scheduler" {
  capabilities = ["read"]
}
