# Devin

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/rshdhere/devin)
[![build-check](https://github.com/rshdhere/devin/actions/workflows/build.yaml/badge.svg?branch=main)](https://github.com/rshdhere/devin/actions/workflows/build.yaml)

[![Watch the Devin demo](https://img.youtube.com/vi/CLgbkPEXK9k/maxresdefault.jpg)](https://youtu.be/CLgbkPEXK9k)

**devin.baby** is a baby devin focused on the core software-engineering loop: submit work, get an isolated runtime, run the agent, stream progress, and persist results in `/workspace`.

## Approach

kubernetes is the **control plane**.


firecracker microVMs are the **execution plane**.

![Devin architecture: orchestrator, Firecracker hosts, microVMs, and SSE event stream](docs/architecture.png)
