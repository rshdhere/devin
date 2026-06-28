#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SCHEDULER_URL:-}" ]]; then
  echo "SCHEDULER_URL is required" >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required to sync SCHEDULER_URL into cluster secrets" >&2
  exit 1
fi

read -r -a namespaces <<< "${NAMESPACES:-devin-app devin-staging}"

for namespace in "${namespaces[@]}"; do
  if ! kubectl get namespace "$namespace" >/dev/null 2>&1; then
    echo "Skipping missing namespace: $namespace"
    continue
  fi

  if kubectl get secret devin-server -n "$namespace" >/dev/null 2>&1; then
    echo "Patching devin-server secret in $namespace (may be reverted by External Secrets without Vault update)"
    kubectl patch secret devin-server \
      -n "$namespace" \
      --type merge \
      -p "{\"stringData\":{\"SCHEDULER_URL\":\"$SCHEDULER_URL\"}}" || true
  fi

  for deploy in devin-server server; do
    if kubectl get deployment "$deploy" -n "$namespace" >/dev/null 2>&1; then
      echo "Setting SCHEDULER_URL on deployment/$deploy in $namespace"
      kubectl set env "deployment/$deploy" -n "$namespace" "SCHEDULER_URL=$SCHEDULER_URL"
      kubectl rollout restart "deployment/$deploy" -n "$namespace"
    fi
  done
done

echo "SCHEDULER_URL synced to deployments in: ${namespaces[*]}"
