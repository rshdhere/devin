package hostpayload

// FreeDisk removes stale microVM state and restarts the Firecracker pool.
// Safe on execution hosts — does not delete golden snapshots under /var/lib/devin/snapshots.
func FreeDisk() string {
	return `#!/bin/bash
set -euo pipefail
echo "==== before ===="
df -h / /var/lib/devin 2>/dev/null || df -h /
du -sh /var/lib/devin/vms /var/lib/devin/task-snapshots 2>/dev/null || true
echo "==== stopping services ===="
systemctl stop devin-scheduler.service 2>/dev/null || true
systemctl stop devin-firecracker.service 2>/dev/null || true
docker rm -f scheduler firecracker 2>/dev/null || true
echo "==== pruning stale VM state ===="
rm -rf /var/lib/devin/vms/*
find /var/lib/devin/task-snapshots -type f -mtime +14 -delete 2>/dev/null || true
docker container prune -f 2>/dev/null || true
echo "==== restarting services ===="
systemctl start devin-firecracker.service
sleep 3
systemctl start devin-scheduler.service
sleep 2
echo "==== after ===="
df -h / /var/lib/devin 2>/dev/null || df -h /
curl -sf http://127.0.0.1:9092/health 2>/dev/null || echo "firecracker health: unavailable"
echo
curl -sf http://127.0.0.1:9091/health 2>/dev/null || echo "scheduler health: unavailable"
echo
`
}
