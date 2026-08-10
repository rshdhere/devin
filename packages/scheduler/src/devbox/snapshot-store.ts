import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function snapshotDir(): string {
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
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${taskId}.png`), data);
}

export async function loadTaskDesktopSnapshot(
  taskId: string,
): Promise<Buffer | undefined> {
  try {
    const data = await readFile(path.join(snapshotDir(), `${taskId}.png`));
    return data.length > 128 ? data : undefined;
  } catch {
    return undefined;
  }
}
