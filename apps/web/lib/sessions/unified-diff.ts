export type DiffLine = {
  kind: "add" | "remove" | "context" | "hunk" | "meta";
  oldLineNo?: number | null;
  newLineNo?: number | null;
  text: string;
};

export type DiffStats = {
  added: number;
  removed: number;
};

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.split("\n");
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode")
    ) {
      result.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match?.[1] != null && match[2] != null) {
        oldLine = Number.parseInt(match[1], 10);
        newLine = Number.parseInt(match[2], 10);
      }
      result.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      result.push({
        kind: "add",
        oldLineNo: null,
        newLineNo: newLine,
        text: line.slice(1),
      });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      result.push({
        kind: "remove",
        oldLineNo: oldLine,
        newLineNo: null,
        text: line.slice(1),
      });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      result.push({
        kind: "context",
        oldLineNo: oldLine,
        newLineNo: newLine,
        text: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (line === "\\ No newline at end of file") {
      continue;
    }
  }

  return result;
}

export function countDiffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    if (line.kind === "remove") removed += 1;
  }
  return { added, removed };
}

export function syntheticAddedDiff(content: string): DiffLine[] {
  const parts = content.split("\n");
  return parts.map((text, index) => ({
    kind: "add" as const,
    oldLineNo: null,
    newLineNo: index + 1,
    text,
  }));
}

export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'"'"'`)}'`;
}

export function buildFileDiffCommand(path: string, repoDir = "repo"): string {
  let rel = path.replace(/\\/g, "/");
  const prefix = `${repoDir}/`;
  if (rel.startsWith(prefix)) {
    rel = rel.slice(prefix.length);
  }
  const quoted = shellQuote(rel);
  return `p=${quoted}; base=$(git merge-base origin/main HEAD 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || echo HEAD); out=$(git diff "$base" HEAD -- "$p" 2>/dev/null); if [ -z "$out" ]; then out=$(git diff HEAD -- "$p" 2>/dev/null); fi; if [ -z "$out" ] && [ -f "$p" ]; then out=$(git diff --no-index /dev/null "$p" 2>/dev/null || true); fi; printf '%s' "$out"`;
}
