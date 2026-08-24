#!/usr/bin/env bash
# Interactive desktop (Snapshot + noVNC) for every Firecracker runtime image.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  xvfb \
  x11vnc \
  websockify \
  novnc \
  ffmpeg
rm -rf /var/lib/apt/lists/*

test -f /usr/share/novnc/core/rfb.js
