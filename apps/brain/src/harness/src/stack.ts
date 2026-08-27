/** Stack labels accepted by the Brain harness (mirrors @devin/types StackRuntime). */
export type BrainStackRuntime = "nextjs" | "node" | "go" | "rust" | "python";

export function normalizeBrainStack(
  value: string | undefined,
): BrainStackRuntime | undefined {
  const v = value?.trim().toLowerCase();
  if (
    v === "nextjs" ||
    v === "node" ||
    v === "go" ||
    v === "rust" ||
    v === "python"
  ) {
    return v;
  }
  return undefined;
}

/** Canonical scaffold entry points the agent should open first. */
export function stackEntryFiles(stack?: BrainStackRuntime): string[] {
  switch (stack) {
    case "nextjs":
      return ["app/page.tsx", "app/layout.tsx", "package.json"];
    case "node":
      return ["src/index.ts", "package.json", "README.md"];
    case "go":
      return ["main.go", "go.mod", "README.md"];
    case "rust":
      return ["src/main.rs", "Cargo.toml", "README.md"];
    case "python":
      return ["app.py", "requirements.txt", "README.md"];
    default:
      return ["README.md"];
  }
}

export function stackGuidanceLines(stack?: BrainStackRuntime): string[] {
  const entries = stackEntryFiles(stack).join(", ");
  switch (stack) {
    case "nextjs":
      return [
        "Stack: Next.js (App Router + TypeScript).",
        `Start from these scaffold files: ${entries}.`,
        "Do not invent a different framework (Express, Flask, etc.).",
      ];
    case "node":
      return [
        "Stack: Node.js / TypeScript (not Next.js).",
        `Start from these scaffold files: ${entries}.`,
        "Do not create app/page.tsx or an App Router tree unless the user asked for Next.js.",
      ];
    case "go":
      return [
        "Stack: Go.",
        `Start from these scaffold files: ${entries}.`,
        "Edit Go sources only. Do not create package.json, app/page.tsx, or Python files.",
        "Use go mod / go run; never bun or npm.",
        "Serve a real HTML UI at GET / in addition to /health — Desktop preview opens /.",
      ];
    case "rust":
      return [
        "Stack: Rust (Cargo).",
        `Start from these scaffold files: ${entries}.`,
        "Edit Rust sources only. Do not create package.json, app/page.tsx, or Python files.",
        "Use cargo build / cargo run; never bun or npm.",
      ];
    case "python":
      return [
        "Stack: Python.",
        `Start from these scaffold files: ${entries}.`,
        "Edit Python sources only (app.py, templates/, static/). Do not create app/page.tsx, package.json, or Next.js files.",
        "Use pip / python; never bun or npm unless the user explicitly asked for a JS frontend.",
      ];
    default:
      return [
        "Discover the real scaffold with list_dir on . before reading files.",
        "Do not assume Next.js (app/page.tsx) unless those files already exist.",
      ];
  }
}

export function isJsUiStack(stack?: BrainStackRuntime): boolean {
  return stack === "nextjs" || stack === "node" || stack === undefined;
}
