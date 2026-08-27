const MAX_OUTPUT_CHARS = 8_000;

export function truncate(value: string, max = MAX_OUTPUT_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}\n… (truncated; narrow your command)`;
}

export function toolErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const message = error.message.trim();
  if (/NOT_FOUND|no such file|ENOENT|HTTP 404/i.test(message)) {
    return `file not found: ${message.slice(0, 240)} — use list_dir / check the path under the repo root (never node_modules)`;
  }
  return `tool error: ${message.slice(0, 400)}`;
}

export function promisify<T>(
  fn: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: T) => void,
  ) => void,
  req: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn(req, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(res);
    });
  });
}
