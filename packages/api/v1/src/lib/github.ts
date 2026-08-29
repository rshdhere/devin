import { db } from "@devin/drizzle";
import { account } from "@devin/drizzle/schema";
import { decryptAccountTokenField } from "@devin/secrets";
import { and, eq } from "drizzle-orm";

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  description: string | null;
}

export interface GitHubConnectionStatus {
  connected: boolean;
  username: string | null;
  scopes: string[];
  hasRepoAccess: boolean;
}

export async function getGitHubAccount(userId: string) {
  const [acct] = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);

  if (!acct) {
    return acct;
  }

  return {
    ...acct,
    accessToken: await decryptAccountTokenField(acct.accessToken),
    refreshToken: await decryptAccountTokenField(acct.refreshToken),
    idToken: await decryptAccountTokenField(acct.idToken),
  };
}

export function parseScopes(scope: string | null | undefined): string[] {
  if (!scope) {
    return [];
  }
  return scope.split(/[\s,]+/).filter(Boolean);
}

export function hasRepoScope(scopes: string[]): boolean {
  return scopes.includes("repo") || scopes.includes("public_repo");
}

export async function getGitHubConnectionStatus(
  userId: string,
): Promise<GitHubConnectionStatus> {
  const acct = await getGitHubAccount(userId);

  if (!acct?.accessToken) {
    return {
      connected: false,
      username: null,
      scopes: [],
      hasRepoAccess: false,
    };
  }

  const scopes = parseScopes(acct.scope);

  try {
    const user = await githubFetch<{ login: string }>(
      acct.accessToken,
      "/user",
    );
    return {
      connected: true,
      username: user.login,
      scopes,
      hasRepoAccess: hasRepoScope(scopes),
    };
  } catch {
    return {
      connected: true,
      username: acct.accountId,
      scopes,
      hasRepoAccess: hasRepoScope(scopes),
    };
  }
}

export async function getGitHubAccessToken(
  userId: string,
): Promise<string | null> {
  const acct = await getGitHubAccount(userId);
  return acct?.accessToken ?? null;
}

export async function githubFetch<T>(
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
    throw new Error(`GitHub API error ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

export async function listUserRepos(token: string): Promise<GitHubRepo[]> {
  return githubFetch<GitHubRepo[]>(
    token,
    "/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member",
  );
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  opts: { title: string; body: string; head: string; base: string },
): Promise<{ html_url: string; number: number }> {
  return githubFetch<{ html_url: string; number: number }>(
    token,
    `/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    },
  );
}

export function authenticatedCloneUrl(
  token: string,
  repository: string,
): string {
  return `https://x-access-token:${token}@github.com/${repository}.git`;
}
