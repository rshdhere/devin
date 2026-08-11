/** Writable paths inside the microVM workspace tmpfs (rootfs is read-only after restore). */
export const SANDBOX_WRITABLE_HOME = "/workspace/.home";

export function sandboxProcessEnv(
  githubToken?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: SANDBOX_WRITABLE_HOME,
    GIT_CONFIG_GLOBAL: `${SANDBOX_WRITABLE_HOME}/.gitconfig`,
    // Prevent interactive git from blocking agent shell tools forever.
    GIT_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
    EDITOR: "true",
    VISUAL: "true",
    PAGER: "cat",
  };
  if (githubToken) {
    env.GITHUB_TOKEN = githubToken;
  }
  return env;
}

export function shellPrepareWritableHome(): string {
  return [
    `mkdir -p ${SANDBOX_WRITABLE_HOME}/.cursor ${SANDBOX_WRITABLE_HOME}/.devin/githooks ${SANDBOX_WRITABLE_HOME}/.local/bin`,
    `rm -f ${SANDBOX_WRITABLE_HOME}/.gitconfig.lock`,
    `export HOME=${SANDBOX_WRITABLE_HOME}`,
    `export GIT_CONFIG_GLOBAL=${SANDBOX_WRITABLE_HOME}/.gitconfig`,
  ].join(" && ");
}
