import type { CreatedIssue } from "./types.js";

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

async function pushAllFilesViaContentsApi(
  token: string,
  owner: string,
  repo: string,
  files: Array<{ path: string; content: string }>,
  message: string,
): Promise<{ sha: string }> {
  let branch: string | undefined;
  let lastSha = "";

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const commitMessage =
      index === files.length - 1 ? message : `Add ${file.path}`;
    const result = await createFileViaContentsApi(
      token,
      owner,
      repo,
      file.path,
      file.content,
      commitMessage,
      index === 0 ? undefined : branch,
    );
    lastSha = result.sha;
    if (!branch) {
      const meta = await githubApiRequest<{ default_branch?: string }>(
        token,
        `/repos/${owner}/${repo}`,
      );
      branch = meta.default_branch ?? "main";
    }
  }

  if (!lastSha) {
    throw new Error("GitHub contents API did not create any commits");
  }

  return { sha: lastSha };
}

async function bootstrapEmptyRepository(
  token: string,
  owner: string,
  repo: string,
  orderedFiles: Array<{ path: string; content: string }>,
  message: string,
  branch: string,
): Promise<{ sha: string; branch: string }> {
  const seedFile =
    orderedFiles.find((file) => file.path === "README.md") ?? orderedFiles[0]!;
  const remainingFiles = orderedFiles.filter(
    (file) => file.path !== seedFile.path,
  );

  const initialized = await initializeEmptyRepositoryWithContentsApi(
    token,
    owner,
    repo,
    seedFile,
    remainingFiles.length === 0 ? message : "chore: initialize repository",
    branch,
  );

  if (remainingFiles.length === 0) {
    return initialized;
  }

  const commit = await createCommitViaGitDatabase(
    token,
    owner,
    repo,
    remainingFiles,
    message,
    initialized.branch,
    initialized.sha,
  );

  return { sha: commit.sha, branch: initialized.branch };
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

  const activeBranch = branch;
  const parentSha = await tryGetBranchHeadSha(token, owner, repo, activeBranch);

  if (parentSha === null) {
    try {
      const bootstrapped = await bootstrapEmptyRepository(
        token,
        owner,
        repo,
        orderedFiles,
        message,
        activeBranch,
      );
      return { sha: bootstrapped.sha };
    } catch (error) {
      if (!isGitRepositoryEmptyError(error)) {
        throw error;
      }
      return pushAllFilesViaContentsApi(
        token,
        owner,
        repo,
        orderedFiles,
        message,
      );
    }
  }

  try {
    return await createCommitViaGitDatabase(
      token,
      owner,
      repo,
      orderedFiles,
      message,
      activeBranch,
      parentSha,
    );
  } catch (error) {
    if (!isGitRepositoryEmptyError(error)) {
      throw error;
    }
    return pushAllFilesViaContentsApi(
      token,
      owner,
      repo,
      orderedFiles,
      message,
    );
  }
}
