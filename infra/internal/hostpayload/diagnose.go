package hostpayload

// Diagnose prints execution-host disk, devin layout, and service health.
func Diagnose() string {
	return `#!/bin/bash
set -euo pipefail
echo "==== host disk ===="
df -h / /var/lib/devin 2>/dev/null || df -h /
echo "==== /var/lib/devin usage ===="
du -sh /var/lib/devin/* 2>/dev/null | sort -hr | head -25 || true
echo "==== docker ===="
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null || true
echo "==== systemd ===="
systemctl is-active devin-firecracker.service devin-scheduler.service 2>/dev/null || true
echo "==== firecracker ===="
curl -sf http://127.0.0.1:9092/health 2>/dev/null || echo "firecracker health: unavailable"
echo
echo "==== scheduler ===="
curl -sf http://127.0.0.1:9091/health 2>/dev/null || echo "scheduler health: unavailable"
echo
`
}
