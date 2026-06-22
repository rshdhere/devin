FROM node:22-bookworm-slim

WORKDIR /workspace
COPY apps/runtime/bin/runtime /usr/local/bin/devin-runtime-supervisor

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devin-runtime-supervisor"]
