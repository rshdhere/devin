function readErrorBody(body: unknown, status?: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
  }
  if (status) {
    return `Runtime request failed (HTTP ${status})`;
  }
  return "Runtime request failed";
}

export async function parseRuntimeResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    status?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };

  if (!response.ok) {
    throw new Error(readErrorBody(body, response.status));
  }

  if (body && typeof body === "object") {
    const status = body.status;
    if (status === "failed" || status === "error") {
      throw new Error(readErrorBody(body, response.status));
    }
    if (typeof body.exitCode === "number" && body.exitCode !== 0) {
      throw new Error(body.stderr || body.stdout || "Command failed");
    }
  }

  return body;
}

export async function parseRuntimeResponseAllowFailure<T>(
  response: Response,
): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    status?: string;
  };

  if (!response.ok) {
    throw new Error(readErrorBody(body, response.status));
  }

  if (body && typeof body === "object") {
    const status = body.status;
    if (status === "failed" || status === "error") {
      throw new Error(readErrorBody(body, response.status));
    }
  }

  return body;
}
