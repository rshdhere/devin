import { pickRandomRepoName } from "./project-metadata.js";

export interface CreatedRepository {
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
}

export interface GitHubUserIdentity {
  login: string;
  name: string;
  email: string;
}

export interface CreatedIssue {
  htmlUrl: string;
  number: number;
}

export function authenticatedCloneUrl(
  token: string,
  repository: string,
): string {
  return `https://x-access-token:${token}@github.com/${repository}.git`;
}

export async function fetchGitHubUserIdentity(
  token: string,
): Promise<GitHubUserIdentity> {
  const user = await githubApiRequest<{
    login: string;
    name?: string | null;
    id: number;
    email?: string | null;
  }>(token, "/user");

  let email = user.email?.trim();
  if (!email) {
    try {
      const emails = await githubApiRequest<
        Array<{ email: string; primary?: boolean; verified?: boolean }>
      >(token, "/user/emails");
      const primary =
        emails.find((entry) => entry.primary && entry.verified) ??
        emails.find((entry) => entry.verified) ??
        emails[0];
      email = primary?.email?.trim();
    } catch {
      // fall back to GitHub noreply address
    }
  }

  return {
    login: user.login,
    name: user.name?.trim() || user.login,
    email: email ?? `${user.id}+${user.login}@users.noreply.github.com`,
  };
}

async function githubApiRequest<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new GitHubApiError(response.status, body);
  }

  return response.json() as Promise<T>;
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`GitHub API error ${status}: ${body}`);
    this.name = "GitHubApiError";
  }
}

function isGitRepositoryEmptyError(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) {
    return false;
  }
  return (
    error.status === 409 &&
    error.body.toLowerCase().includes("git repository is empty")
  );
}

function encodeBase64Content(content: string): string {
  return Buffer.from(content, "utf-8").toString("base64");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForGitHubRepository(
  token: string,
  owner: string,
  repo: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (response.ok) {
      await sleep(750);
      return;
    }

    if (response.status !== 404 && response.status !== 409) {
      const body = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${body}`);
    }

    await sleep(500);
  }

  throw new Error(
    `Timed out waiting for GitHub repository ${owner}/${repo} to become available`,
  );
}

async function createFileViaContentsApi(
  token: string,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch?: string,
): Promise<{ sha: string }> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        message,
        content: encodeBase64Content(content),
        ...(branch ? { branch } : {}),
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new GitHubApiError(response.status, body);
  }

  const payload = (await response.json()) as {
    commit?: { sha?: string };
  };
  const sha = payload.commit?.sha;
  if (!sha) {
    throw new Error("GitHub contents API did not return a commit SHA");
  }
  return { sha };
}

async function getBranchHeadSha(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const ref = await githubApiRequest<{ object: { sha: string } }>(
    token,
    `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
  );
  return ref.object.sha;
}

async function createCommitViaGitDatabase(
  token: string,
  owner: string,
  repo: string,
  files: Array<{ path: string; content: string }>,
  message: string,
  branch: string,
  parentSha?: string,
): Promise<{ sha: string }> {
  const treeEntries = await Promise.all(
    files.map(async (file) => {
      const blob = await githubApiRequest<{ sha: string }>(
        token,
        `/repos/${owner}/${repo}/git/blobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: file.content,
            encoding: "utf-8",
          }),
        },
      );
      return {
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      };
    }),
  );

  const tree = await githubApiRequest<{ sha: string }>(
    token,
    `/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tree: treeEntries }),
    },
  );

  const commit = await githubApiRequest<{ sha: string }>(
    token,
    `/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        tree: tree.sha,
        ...(parentSha ? { parents: [parentSha] } : {}),
      }),
    },
  );

  if (parentSha) {
    await githubApiRequest(
      token,
      `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha: commit.sha }),
      },
    );
    return { sha: commit.sha };
  }

  try {
    await githubApiRequest(token, `/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      }),
    });
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 422) {
      throw error;
    }
    await githubApiRequest(
      token,
      `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha: commit.sha }),
      },
    );
  }

  return { sha: commit.sha };
}

async function initializeEmptyRepositoryWithContentsApi(
  token: string,
  owner: string,
  repo: string,
  file: { path: string; content: string },
  message: string,
  branch: string,
): Promise<{ sha: string; branch: string }> {
  try {
    const created = await createFileViaContentsApi(
      token,
      owner,
      repo,
      file.path,
      file.content,
      message,
      branch,
    );
    return { sha: created.sha, branch };
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) {
      throw error;
    }
  }

  const created = await createFileViaContentsApi(
    token,
    owner,
    repo,
    file.path,
    file.content,
    message,
  );

  const repoMeta = await githubApiRequest<{ default_branch?: string }>(
    token,
    `/repos/${owner}/${repo}`,
  );

  return {
    sha: created.sha,
    branch: repoMeta.default_branch ?? branch,
  };
}

export async function createGitHubRepository(
  token: string,
  name: string,
  opts?: { description?: string; private?: boolean },
): Promise<CreatedRepository> {
  const response = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      name,
      description: opts?.description,
      private: opts?.private ?? false,
      auto_init: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub repo create error ${response.status}: ${body}`);
  }

  const repo = (await response.json()) as {
    full_name: string;
    html_url: string;
    default_branch?: string;
  };

  return {
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch ?? "main",
  };
}

export function isRepositoryNameTakenError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes('"code":"custom"') &&
    error.message.includes('"field":"name"') &&
    error.message.includes("already exists")
  );
}

export async function createGitHubRepositoryUnique(
  token: string,
  opts?: {
    description?: string;
    private?: boolean;
    preferredName?: string;
    pickName?: () => string;
  },
): Promise<CreatedRepository & { name: string }> {
  const tried = new Set<string>();
  const pickName = opts?.pickName ?? pickRandomRepoName;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    let name = opts?.preferredName?.trim();
    if (!name || tried.has(name)) {
      do {
        name = pickName();
      } while (tried.has(name));
    }
    tried.add(name);

    try {
      const created = await createGitHubRepository(token, name, opts);
      return { ...created, name };
    } catch (error) {
      if (!isRepositoryNameTakenError(error) || attempt === 7) {
        throw error;
      }
    }
  }

  throw new Error("Could not create a uniquely named repository");
}

export async function fetchRepository(
  token: string,
  owner: string,
  repo: string,
): Promise<{
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
} | null> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    full_name: string;
    html_url: string;
    default_branch?: string;
  };

  return {
    fullName: data.full_name,
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch ?? "main",
  };
}

export async function createGitHubIssue(
  token: string,
  owner: string,
  repo: string,
  opts: { title: string; body?: string },
): Promise<CreatedIssue> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub issue error ${response.status}: ${body}`);
  }

  const issue = (await response.json()) as {
    html_url: string;
    number: number;
  };

  return {
    htmlUrl: issue.html_url,
    number: issue.number,
  };
}

export async function fetchDefaultBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    return "main";
  }
  const data = (await response.json()) as { default_branch?: string };
  return data.default_branch ?? "main";
}

export async function createGitHubPullRequest(
  token: string,
  owner: string,
  repo: string,
  opts: { title: string; body: string; head: string; base: string },
): Promise<{ html_url: string; number: number }> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(opts),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub PR error ${response.status}: ${body}`);
  }
  return response.json() as Promise<{ html_url: string; number: number }>;
}

export async function createGitHubInitialCommit(
  token: string,
  owner: string,
  repo: string,
  files: Array<{ path: string; content: string }>,
  message: string,
  branch = "main",
): Promise<{ sha: string }> {
  if (files.length === 0) {
    throw new Error("initial commit requires at least one file");
  }

  await waitForGitHubRepository(token, owner, repo);

  const orderedFiles = [...files].sort((left, right) => {
    if (left.path === "README.md") return -1;
    if (right.path === "README.md") return 1;
    return left.path.localeCompare(right.path);
  });

  try {
    return await createCommitViaGitDatabase(
      token,
      owner,
      repo,
      orderedFiles,
      message,
      branch,
    );
  } catch (error) {
    if (!isGitRepositoryEmptyError(error)) {
      throw error;
    }
  }

  const seedFile =
    orderedFiles.find((file) => file.path === "README.md") ?? orderedFiles[0]!;
  const initialized = await initializeEmptyRepositoryWithContentsApi(
    token,
    owner,
    repo,
    seedFile,
    message,
    branch,
  );
  const activeBranch = initialized.branch;

  if (orderedFiles.length === 1) {
    return { sha: initialized.sha };
  }

  const parentSha = await getBranchHeadSha(token, owner, repo, activeBranch);

  return createCommitViaGitDatabase(
    token,
    owner,
    repo,
    orderedFiles,
    message,
    activeBranch,
    parentSha,
  );
}
