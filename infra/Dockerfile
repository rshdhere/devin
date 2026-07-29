FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/devin-infra ./cmd/devin-infra

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/devin-infra /usr/local/bin/devin-infra
ENTRYPOINT ["/usr/local/bin/devin-infra"]
