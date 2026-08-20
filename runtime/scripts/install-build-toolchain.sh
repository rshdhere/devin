#!/usr/bin/env bash
# Shared guest toolchain for every Firecracker runtime image.
# Installs GCC/build-essential and a system Rust toolchain under /usr/local
# so cargo/rustc work immediately after snapshot restore (rootfs is read-only;
# writable cargo caches live on /workspace/.build at runtime).
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  pkg-config \
  libssl-dev \
  cmake \
  g++ \
  make
rm -rf /var/lib/apt/lists/*

export RUSTUP_HOME=/usr/local/rustup
export CARGO_HOME=/usr/local/cargo
export PATH="/usr/local/cargo/bin:${PATH}"

if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain 1.83.0 --profile minimal --no-modify-path
fi

# Stable paths for shells that strip PATH to /usr/local/bin first.
mkdir -p /usr/local/bin
if [[ -x /usr/local/cargo/bin/cargo ]]; then
  ln -sfn /usr/local/cargo/bin/cargo /usr/local/bin/cargo
fi
if [[ -x /usr/local/cargo/bin/rustc ]]; then
  ln -sfn /usr/local/cargo/bin/rustc /usr/local/bin/rustc
fi
if [[ -x /usr/local/cargo/bin/rustup ]]; then
  ln -sfn /usr/local/cargo/bin/rustup /usr/local/bin/rustup
fi

cargo --version
rustc --version
gcc --version | head -1
