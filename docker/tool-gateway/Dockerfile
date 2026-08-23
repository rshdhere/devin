FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY apps/tool-gateway/go.mod apps/tool-gateway/go.sum ./
RUN go mod download
COPY apps/tool-gateway/ ./
RUN CGO_ENABLED=0 go build -o /out/tool-gateway .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/tool-gateway /usr/bin/tool-gateway
ENV TOOL_GATEWAY_GRPC_ADDR=:9095
EXPOSE 9095
ENTRYPOINT ["/usr/bin/tool-gateway"]
