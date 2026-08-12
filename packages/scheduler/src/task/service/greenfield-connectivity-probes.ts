import { RuntimeClient } from "@devin/agent-sdk";
import type { TaskService } from "./task-service.js";
import { escapeShell } from "./config.js";

export async function probeSandboxDns(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  host: string,
): Promise<{ ok: boolean; detail: string }> {
  // Wrap getent in timeout — a wedged resolver can hang for many minutes and
  // leave the UI sitting on an empty agent panel after hydrate.
  const result = await runtime.terminalAllowFailure({
    taskId,
    command: `timeout 5 getent ahostsv4 '${escapeShell(host)}' 2>/dev/null | awk 'NR==1{print $1; exit}' || timeout 5 getent ahosts '${escapeShell(host)}' 2>/dev/null | awk '/STREAM/{print $1; exit}'`,
  });
  const address = result.stdout.trim();
  if (result.exitCode === 0 && address) {
    return { ok: true, detail: address };
  }
  return {
    ok: false,
    detail: (result.stderr || result.stdout || "DNS lookup failed").trim(),
  };
}

export async function probeSandboxHttps(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  url: string,
): Promise<{ ok: boolean; detail: string }> {
  const result = await runtime.terminalAllowFailure({
    taskId,
    command: [
      "set +e",
      `url='${escapeShell(url)}'`,
      "if command -v curl >/dev/null 2>&1; then",
      "  out=$(curl -4sS --connect-timeout 5 --max-time 8 -o /dev/null -w '%{http_code}' \"$url\" 2>&1)",
      "  code=$?",
      '  echo "$out"',
      "  if echo \"$out\" | grep -qi 'Structure needs cleaning'; then",
      "    echo 'guest-fs-corrupt'",
      "  fi",
      "  exit $code",
      "fi",
      "if command -v node >/dev/null 2>&1; then",
      '  node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(8000)}).then(r=>{console.log(r.status); process.exit(0)}).catch(e=>{console.error(String(e)); process.exit(1)})" "$url"',
      "  exit $?",
      "fi",
      "echo 'no-https-client'",
      "exit 127",
    ].join("\n"),
  });
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (/guest-fs-corrupt|Structure needs cleaning/i.test(combined)) {
    return {
      ok: false,
      detail:
        "guest filesystem corrupt (Structure needs cleaning) — rebuild agent/nextjs snapshots",
    };
  }
  const httpCode =
    combined
      .split(/\s+/)
      .reverse()
      .find((token) => /^[0-9]{3}$/.test(token)) ?? "";
  if (httpCode && httpCode !== "000") {
    return { ok: true, detail: `HTTP ${httpCode}` };
  }
  return {
    ok: false,
    detail: combined || `exit ${result.exitCode}`,
  };
}
