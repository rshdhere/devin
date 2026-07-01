#!/usr/bin/env bash
set -euo pipefail

CNI_STATE_DIR="${CNI_STATE_DIR:-/var/lib/cni}"
NETNS_DIR="${NETNS_DIR:-/var/run/netns}"
CNI_NETWORK="${CNI_NETWORK:-fcnet}"
DRY_RUN="${DRY_RUN:-false}"

log() {
  echo "[$(date -Iseconds)] $*"
}

cleanup_stale_container_state() {
  log "Checking for stale CNI container state in $CNI_STATE_DIR..."
  
  if [[ ! -d "$CNI_STATE_DIR" ]]; then
    log "CNI state directory does not exist, nothing to clean"
    return
  fi

  local cleaned=0
  for dir in "$CNI_STATE_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    local container_id
    container_id=$(basename "$dir")
    
    [[ "$container_id" == "networks" ]] && continue
    [[ "$container_id" == "results" ]] && continue
    
    local netns_path="$NETNS_DIR/$container_id"
    
    if [[ ! -e "$netns_path" ]]; then
      log "Found stale state for container $container_id (netns $netns_path does not exist)"
      if [[ "$DRY_RUN" == "false" ]]; then
        rm -rf "$dir"
        log "  Removed $dir"
        ((cleaned++)) || true
      else
        log "  [DRY-RUN] Would remove $dir"
      fi
    fi
  done
  
  log "Cleaned $cleaned stale container state entries"
}

cleanup_orphaned_ips() {
  local host_local_dir="$CNI_STATE_DIR/networks/$CNI_NETWORK"
  
  if [[ ! -d "$host_local_dir" ]]; then
    log "host-local IPAM directory does not exist: $host_local_dir"
    return
  fi
  
  log "Checking for orphaned IP allocations in $host_local_dir..."
  
  local cleaned=0
  for ip_file in "$host_local_dir"/*; do
    [[ -f "$ip_file" ]] || continue
    
    local ip_name
    ip_name=$(basename "$ip_file")
    
    [[ "$ip_name" == "last_reserved_ip.0" ]] && continue
    [[ "$ip_name" == "lock" ]] && continue
    
    local container_id
    container_id=$(cat "$ip_file" 2>/dev/null || echo "")
    
    if [[ -z "$container_id" ]]; then
      continue
    fi
    
    local netns_path="$NETNS_DIR/$container_id"
    
    if [[ ! -e "$netns_path" ]]; then
      log "Found orphaned IP allocation: $ip_name -> $container_id (netns does not exist)"
      if [[ "$DRY_RUN" == "false" ]]; then
        rm -f "$ip_file"
        log "  Released IP $ip_name"
        ((cleaned++)) || true
      else
        log "  [DRY-RUN] Would release IP $ip_name"
      fi
    fi
  done
  
  log "Released $cleaned orphaned IP allocations"
}

show_current_state() {
  log "=== Current CNI State ==="
  
  if [[ -d "$CNI_STATE_DIR" ]]; then
    log "Container state directories:"
    for dir in "$CNI_STATE_DIR"/*/; do
      [[ -d "$dir" ]] || continue
      local name
      name=$(basename "$dir")
      [[ "$name" == "networks" || "$name" == "results" ]] && continue
      local netns="$NETNS_DIR/$name"
      local status="active"
      [[ ! -e "$netns" ]] && status="STALE"
      echo "  $name [$status]"
    done
  fi
  
  local host_local_dir="$CNI_STATE_DIR/networks/$CNI_NETWORK"
  if [[ -d "$host_local_dir" ]]; then
    log "IP allocations for $CNI_NETWORK:"
    for ip_file in "$host_local_dir"/*; do
      [[ -f "$ip_file" ]] || continue
      local ip_name
      ip_name=$(basename "$ip_file")
      [[ "$ip_name" == "last_reserved_ip.0" || "$ip_name" == "lock" ]] && continue
      local container_id
      container_id=$(cat "$ip_file" 2>/dev/null || echo "unknown")
      local netns="$NETNS_DIR/$container_id"
      local status="active"
      [[ ! -e "$netns" ]] && status="ORPHANED"
      echo "  $ip_name -> $container_id [$status]"
    done
  fi
  
  log "=== Active Network Namespaces ==="
  if [[ -d "$NETNS_DIR" ]]; then
    ls -la "$NETNS_DIR" 2>/dev/null || echo "  (empty)"
  fi
}

main() {
  local cmd="${1:-cleanup}"
  
  case "$cmd" in
    cleanup)
      log "Starting CNI state cleanup (DRY_RUN=$DRY_RUN)..."
      cleanup_stale_container_state
      cleanup_orphaned_ips
      log "Cleanup complete"
      ;;
    status)
      show_current_state
      ;;
    *)
      echo "Usage: $0 [cleanup|status]"
      echo ""
      echo "Environment variables:"
      echo "  DRY_RUN=true     Preview changes without making them"
      echo "  CNI_NETWORK=...  CNI network name (default: fcnet)"
      echo "  CNI_STATE_DIR=.. CNI state directory (default: /var/lib/cni)"
      echo "  NETNS_DIR=...    Network namespace directory (default: /var/run/netns)"
      exit 1
      ;;
  esac
}

main "$@"
