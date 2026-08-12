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
