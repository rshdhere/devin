# devin-infra CLI

Go module `github.com/rshdhere/devin/infra` (Go 1.24; AWS SDK v2 requires it).

```text
go build -o bin/devin-infra ./cmd/devin-infra
```

Operator commands (workstation/CI), default region `ap-south-1`:

```text
devin-infra deploy-images --discover
devin-infra bootstrap-snapshots i-0123456789abcdef0
devin-infra rebuild-agent-snapshot i-0123456789abcdef0
devin-infra sync-host-config i-0123456789abcdef0
devin-infra enable-nested-virt i-0123456789abcdef0
devin-infra rebootstrap i-0123456789abcdef0
SCHEDULER_URL=http://scheduler:9091 devin-infra patch-scheduler-url
devin-infra set-platform-secret cursor_api_key
devin-infra configure-profile
devin-infra install-ssm-plugin
```

Host commands (execution host as root). Prefer installing the binary in
userdata, then:

```text
sudo devin-infra install-self
sudo devin-infra sync-platform-config
sudo devin-infra bootstrap-snapshots-local
sudo devin-infra host-deploy
sudo devin-infra fix-sandbox-dns
sudo devin-infra fix-cni
```

SSM remote payloads live as Go string templates in `internal/hostpayload`.
Execution-host userdata installs this binary (image extract or source build)
and runs `sync-platform-config` on a timer.
