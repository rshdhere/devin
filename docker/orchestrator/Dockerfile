FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY apps/orchestrator apps/orchestrator
COPY packages/orchestrator packages/orchestrator
COPY packages/sandbox packages/sandbox
WORKDIR /src/apps/orchestrator
RUN CGO_ENABLED=0 go build -o /out/orchestrator ./cmd/orchestrator

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/orchestrator /orchestrator
EXPOSE 9090
ENTRYPOINT ["/orchestrator"]
