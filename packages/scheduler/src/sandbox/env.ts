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
    // Keep package-manager caches off the writable home tree (tmpfs is tight).
    PIP_NO_CACHE_DIR: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    npm_config_cache: "/workspace/.build/npm-cache",
    XDG_CACHE_HOME: "/workspace/.build/xdg-cache",
    CARGO_HOME: "/workspace/.build/cargo-home",
    CARGO_TARGET_DIR: "/workspace/.build/target",
  };
  if (githubToken) {
    env.GITHUB_TOKEN = githubToken;
  }
  return env;
}

export function shellPrepareWritableHome(): string {
  return [
    `mkdir -p ${SANDBOX_WRITABLE_HOME}/.cursor ${SANDBOX_WRITABLE_HOME}/.devin/githooks ${SANDBOX_WRITABLE_HOME}/.local/bin`,
    "mkdir -p /workspace/.build/npm-cache /workspace/.build/xdg-cache /workspace/.build/cargo-home /workspace/.build/target",
    `rm -f ${SANDBOX_WRITABLE_HOME}/.gitconfig.lock`,
    `export HOME=${SANDBOX_WRITABLE_HOME}`,
    `export GIT_CONFIG_GLOBAL=${SANDBOX_WRITABLE_HOME}/.gitconfig`,
    "export PIP_NO_CACHE_DIR=1",
    "export npm_config_cache=/workspace/.build/npm-cache",
    "export XDG_CACHE_HOME=/workspace/.build/xdg-cache",
    "export CARGO_HOME=/workspace/.build/cargo-home",
    "export CARGO_TARGET_DIR=/workspace/.build/target",
  ].join(" && ");
}
