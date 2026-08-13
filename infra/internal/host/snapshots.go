package host

import "os"

// schedulerContainerUID matches USER app in docker/scheduler/Dockerfile.
const schedulerContainerUID = 1001

const taskSnapshotDir = "/var/lib/devin/task-snapshots"

// ensureTaskSnapshotDir creates the host snapshot cache with ownership for the
// scheduler container (non-root app user).
func ensureTaskSnapshotDir() error {
	if err := os.MkdirAll(taskSnapshotDir, 0o755); err != nil {
		return err
	}
	return os.Chown(taskSnapshotDir, schedulerContainerUID, schedulerContainerUID)
}
