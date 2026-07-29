export interface ProjectMetadata {
  title: string;
  repoName: string;
  description: string;
}

const PROJECT_NAME_POOL = [
  "cedar-studio",
  "nova-forge",
  "pulse-app",
  "harbor-kit",
  "atlas-lab",
  "bloom-stack",
  "cipher-hub",
  "drift-base",
  "ember-works",
  "flux-node",
  "grove-dev",
  "helm-craft",
  "iris-lab",
  "jetty-app",
  "kinetic-kit",
  "lucent-hub",
  "mosaic-dev",
  "nexus-forge",
  "orbit-lab",
  "prism-stack",
  "quill-base",
  "ripple-kit",
  "slate-hub",
  "terra-node",
  "vertex-lab",
  "willow-stack",
  "zenith-kit",
  "anchor-lab",
  "bridge-forge",
  "canvas-node",
] as const;

function randomSuffix(length = 4): string {
  return Math.random()
    .toString(36)
    .replace(/[^a-z0-9]/g, "")
    .slice(0, length)
    .padEnd(length, "x");
}

function titleFromRepoSlug(repoName: string): string {
  const base = repoName.replace(/-[a-z0-9]{4}$/, "");
  return base
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function pickRandomRepoName(): string {
  const base =
    PROJECT_NAME_POOL[Math.floor(Math.random() * PROJECT_NAME_POOL.length)] ??
    "devin-project";
  return `${base}-${randomSuffix()}`;
}

export function generateProjectMetadata(prompt: string): ProjectMetadata {
  const repoName = pickRandomRepoName();

  return {
    title: titleFromRepoSlug(repoName),
    repoName,
    description: prompt.trim().slice(0, 200),
  };
}
