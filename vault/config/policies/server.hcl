# Server (devin-server) — API gateway secrets.
path "secret/data/dev/server" {
  capabilities = ["read"]
}

path "secret/data/staging/server" {
  capabilities = ["read"]
}

path "secret/data/prod/server" {
  capabilities = ["read"]
}
