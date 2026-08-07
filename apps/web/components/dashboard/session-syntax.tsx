"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type ChangeKind = "added" | "modified" | "plain";

const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|import|export|from|async|await|type|interface|struct|impl|fn|pub|use|mod|enum|class|extends|new|try|catch|void|boolean|string|number|null|undefined|true|false)\b/g;
const STRINGS = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
const COMMENTS = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;
const NUMBERS = /\b\d+\.?\d*\b/g;
const TYPES = /\b([A-Z][A-Za-z0-9_]*)\b/g;

function highlightLine(line: string, langHint: string): ReactNode[] {
  if (langHint === "plain") {
    return [line];
  }

  const tokens: Array<{ start: number; end: number; className: string }> = [];

  const pushMatches = (regex: RegExp, className: string) => {
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      tokens.push({
        start: match.index,
        end: match.index + match[0].length,
        className,
      });
    }
  };

  pushMatches(COMMENTS, "text-zinc-500");
  pushMatches(STRINGS, "text-[#e5c07b]");
  if (langHint === "ts") {
    pushMatches(/\b(import|export|from|type|interface)\b/g, "text-[#c586c0]");
    pushMatches(TYPES, "text-[#4ec9b0]");
    pushMatches(/\b(function)\b/g, "text-[#dcdcaa]");
  }
  pushMatches(KEYWORDS, "text-[#569cd6]");
  pushMatches(NUMBERS, "text-[#b5cea8]");

  tokens.sort((a, b) => a.start - b.start);
  const merged: typeof tokens = [];
  for (const token of tokens) {
    const last = merged[merged.length - 1];
    if (last && token.start < last.end) continue;
    merged.push(token);
  }

  if (merged.length === 0) {
    return [line];
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const token of merged) {
    if (token.start > cursor) {
      parts.push(line.slice(cursor, token.start));
    }
    parts.push(
      <span
        key={`${token.start}-${token.className}`}
        className={token.className}
      >
        {line.slice(token.start, token.end)}
      </span>,
    );
    cursor = token.end;
  }
  if (cursor < line.length) {
    parts.push(line.slice(cursor));
  }
  return parts;
}

function langFromPath(path: string): string {
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "ts";
  if (path.endsWith(".rs")) return "rs";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".py")) return "py";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".json")) return "json";
  return "plain";
}

export function changeKindFromType(changeType: string): ChangeKind {
  const normalized = changeType.toLowerCase();
  if (
    normalized === "added" ||
    normalized === "create" ||
    normalized === "created"
  ) {
    return "added";
  }
  if (normalized === "modified" || normalized === "modify") {
    return "modified";
  }
  return "plain";
}

export function formatPathContext(path: string): string {
  const parts = path.split("/");
  if (parts.length < 2) {
    return parts[0] ?? "";
  }
  const parent = parts[parts.length - 2];
  const root = parts[0];
  if (parent && root && parent !== root) {
    return `${parent} · ${root}`;
  }
  return parts.slice(0, -1).join(" · ");
}

export function SessionCodeBlock({
  path,
  content,
  changeKind = "plain",
  className,
}: {
  path: string;
  content: string;
  changeKind?: ChangeKind;
  className?: string;
}) {
  const lines = content.split("\n");
  const lang = langFromPath(path);
  const addedBg = "bg-[#1a2f1a]/80";
  const modifiedBg = "bg-[#2a2418]/80";

  return (
    <pre
      className={cn(
        "overflow-x-auto py-1 font-mono text-[12px] leading-[1.6] text-[#d4d4d4]",
        className,
      )}
    >
      <code>
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              "flex min-h-[22px]",
              changeKind === "added" && addedBg,
              changeKind === "modified" && modifiedBg,
            )}
          >
            <span
              className={cn(
                "w-12 shrink-0 pr-3 text-right tabular-nums select-none",
                changeKind === "added"
                  ? "text-emerald-600/70"
                  : "text-zinc-600",
              )}
            >
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 pr-4 whitespace-pre">
              {highlightLine(line, lang)}
            </span>
          </div>
        ))}
      </code>
    </pre>
  );
}

export function SessionDiffView({
  path,
  lines,
  className,
}: {
  path: string;
  lines: import("@/lib/sessions/unified-diff").DiffLine[];
  className?: string;
}) {
  const lang = langFromPath(path);

  return (
    <pre
      className={cn(
        "overflow-x-auto py-1 font-mono text-[12px] leading-[1.6] text-[#d4d4d4]",
        className,
      )}
    >
      <code>
        {lines.map((line, index) => {
          if (line.kind === "hunk") {
            return (
              <div
                key={`hunk-${index}`}
                className="bg-white/[0.03] px-3 py-1 text-[11px] text-zinc-500"
              >
                {line.text}
              </div>
            );
          }
          if (line.kind === "meta") {
            return null;
          }

          const isAdd = line.kind === "add";
          const isRemove = line.kind === "remove";
          const bg = isAdd
            ? "bg-[#1a3d1a]/90"
            : isRemove
              ? "bg-[#3d1a1a]/90"
              : "";

          return (
            <div
              key={`${line.kind}-${index}`}
              className={cn("flex min-h-[22px]", bg)}
            >
              <span
                className={cn(
                  "w-10 shrink-0 pr-2 text-right tabular-nums select-none",
                  isRemove ? "text-rose-500/60" : "text-zinc-600",
                )}
              >
                {line.oldLineNo ?? ""}
              </span>
              <span
                className={cn(
                  "w-10 shrink-0 pr-3 text-right tabular-nums select-none",
                  isAdd ? "text-emerald-500/70" : "text-zinc-600",
                )}
              >
                {line.newLineNo ?? ""}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 pr-4 whitespace-pre",
                  isRemove && "text-rose-200/80",
                )}
              >
                {isRemove ? (
                  <span className="text-rose-300/50">- </span>
                ) : isAdd ? (
                  <span className="text-emerald-400/50">+ </span>
                ) : null}
                {highlightLine(line.text, lang)}
              </span>
            </div>
          );
        })}
      </code>
    </pre>
  );
}
