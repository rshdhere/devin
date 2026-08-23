# Devin tool-gateway

Go gRPC front-door for Brain → Devbox tools. Translates `DevboxTools` RPCs to
the guest runtime HTTP API (`/terminal`, `/files/*`, `/git/*`, desktop).

Runs on the **execution host** (same plane as the worker), not on EKS brain.
Systemd unit: `devin-tool-gateway.service` (Docker `--name tool-gateway`, host
network, `:9095`). The worker dials `TOOL_GATEWAY_GRPC_URL=127.0.0.1:9095`.

```bash
export TOOL_GATEWAY_GRPC_ADDR=:9095
go run .
```

Docker:

```bash
docker build -f docker/tool-gateway/Dockerfile -t devin-tool-gateway:latest .
docker run --rm --network host -e TOOL_GATEWAY_GRPC_ADDR=:9095 devin-tool-gateway:latest
```

Proto source: `apps/brain/src/proto/devbox/v1/tools.proto`

Regenerate:

```bash
protoc -I apps/brain/src/proto \
  --go_out=apps/tool-gateway/gen --go_opt=paths=source_relative \
  --go-grpc_out=apps/tool-gateway/gen --go-grpc_opt=paths=source_relative \
  apps/brain/src/proto/devbox/v1/tools.proto
```
