/** ext4 / overlay corruption signals inside Firecracker guests. */
export function isGuestFilesystemCorrupt(detail: string): boolean {
  const lower = detail.toLowerCase();
  return (
    lower.includes("structure needs cleaning") ||
    lower.includes("guest-fs-corrupt") ||
    lower.includes("guest filesystem corrupt") ||
    lower.includes("bad message") ||
    /cannot create \/tmp\//i.test(detail)
  );
}

export const GUEST_FS_REBUILD_HINT =
  "On the execution host run: sudo devin-infra fix-guest-fs --discover " +
  "(or DEVIN_FORCE_SNAPSHOT_REBUILD=true DEVIN_RUNTIMES='agent nextjs' " +
  "devin-infra bootstrap-snapshots <instance-id>), then retry the task.";
