import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadTaskDesktopSnapshotS3,
  saveTaskDesktopSnapshotS3,
} from "./snapshot-s3.js";

/**
 * Host-local PNG cache for desktop snapshots (scheduler worker).
 *
 * Prefer Postgres (`agent_sessions.desktop_snapshot`) for cross-worker / brain
 * durability. Disk is a fast local cache — set `DEVIN_SNAPSHOT_DIR` to a
 * persistent host path (default `/var/lib/devin/task-snapshots` in production).
 */
export function snapshotDir(): string {
  return (
    process.env.DEVIN_SNAPSHOT_DIR?.trim() ||
    path.join(process.env.TMPDIR || "/tmp", "devin-task-snapshots")
  );
}

export async function saveTaskDesktopSnapshot(
  taskId: string,
  data: Buffer,
): Promise<void> {
  if (data.length < 128) {
    return;
  }
  const dir = snapshotDir();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${taskId}.png`), data);
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
    if (code === "EACCES" || code === "EPERM") {
      console.warn(
        `desktop snapshot disk cache skipped (${code}): ${dir}/${taskId}.png`,
      );
    } else {
      throw error;
    }
  }
  await saveTaskDesktopSnapshotS3(taskId, data);
}

export async function loadTaskDesktopSnapshot(
  taskId: string,
): Promise<Buffer | undefined> {
  const fromS3 = await loadTaskDesktopSnapshotS3(taskId);
  if (fromS3) {
    return fromS3;
  }
  try {
    const data = await readFile(path.join(snapshotDir(), `${taskId}.png`));
    return data.length > 128 ? data : undefined;
  } catch {
    return undefined;
  }
}
