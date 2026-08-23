/** Normalize sandbox file paths to workspace-relative form (e.g. repo/app.py). */
export function normalizeSandboxFilePath(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  if (!p) {
    return p;
  }
  let prev = "";
  while (p !== prev) {
    prev = p;
    while (p.startsWith("/workspace/")) {
      p = p.slice("/workspace/".length);
    }
    p = p.replace(/^\/+/, "");
    while (p.startsWith("workspace/")) {
      p = p.slice("workspace/".length);
    }
  }
  // UI/agent paths are usually repo-relative (app/page.tsx). Guest files live
  // under /workspace/repo/… — prefix when missing so Changes reads succeed.
  if (
    p &&
    p !== "." &&
    !p.startsWith("repo/") &&
    p !== "repo" &&
    !p.startsWith(".home/") &&
    !p.startsWith(".build/")
  ) {
    return `repo/${p}`;
  }
  return p;
}
