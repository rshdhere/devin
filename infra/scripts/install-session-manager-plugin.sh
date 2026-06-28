#!/usr/bin/env bash
# Install AWS Session Manager plugin (required for `aws ssm start-session`).
# Idempotent — safe to re-run.
set -euo pipefail

if command -v session-manager-plugin >/dev/null 2>&1; then
  echo "session-manager-plugin already installed: $(session-manager-plugin --version)"
  exit 0
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
TMPDIR="${TMPDIR:-/tmp}"
DEB="${TMPDIR}/session-manager-plugin.deb"

case "${OS}:${ARCH}" in
  Linux:x86_64)
    URL="https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb"
    ;;
  Linux:aarch64|Linux:arm64)
    URL="https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_arm64/session-manager-plugin.deb"
    ;;
  Darwin:x86_64)
    URL="https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac/sessionmanager-bundle.zip"
    ;;
  Darwin:arm64)
    URL="https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac_arm64/sessionmanager-bundle.zip"
    ;;
  *)
    echo "Unsupported platform: ${OS} ${ARCH}" >&2
    echo "See https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html" >&2
    exit 1
    ;;
esac

if [[ "${OS}" == Linux ]]; then
  curl -fsSL "${URL}" -o "${DEB}"
  if command -v sudo >/dev/null 2>&1; then
    sudo dpkg -i "${DEB}"
  else
    dpkg -i "${DEB}"
  fi
  rm -f "${DEB}"
elif [[ "${OS}" == Darwin ]]; then
  ZIP="${TMPDIR}/sessionmanager-bundle.zip"
  BUNDLE="${TMPDIR}/sessionmanager-bundle"
  curl -fsSL "${URL}" -o "${ZIP}"
  unzip -qo "${ZIP}" -d "${TMPDIR}"
  if command -v sudo >/dev/null 2>&1; then
    sudo "${BUNDLE}/install" -i /usr/local/sessionmanagerplugin -b /usr/local/bin/session-manager-plugin
  else
    "${BUNDLE}/install" -i /usr/local/sessionmanagerplugin -b /usr/local/bin/session-manager-plugin
  fi
  rm -rf "${ZIP}" "${BUNDLE}"
fi

echo "Installed: $(session-manager-plugin --version)"
echo "Connect: aws ssm start-session --region ap-south-1 --target <instance-id>"
