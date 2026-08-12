import { RuntimeClient } from "@devin/agent-sdk";
import { usesRuntimeAgent } from "../../agent/defaults.js";
import type { StackRuntime } from "@devin/types";
import {
  authenticatedCloneUrl,
  createGitHubInitialCommit,
  createGitHubRepositoryUnique,
  fetchGitHubUserIdentity,
  type GitHubUserIdentity,
} from "../../github/client.js";
import {
  generateDraftPlan,
  type DraftPlan,
} from "../../greenfield/draft-planner.js";
import { generateProjectMetadata } from "../../greenfield/project-metadata.js";
import { scaffoldFilesFromDraft } from "../../greenfield/scaffold-from-draft.js";
import { greenfieldShellScaffoldFiles } from "../../greenfield/shell-scaffold.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import {
  buildCommitMessage,
  escapeShell,
  isNetworkCloneFailure,
  resolveStackRuntime,
  sleep,
} from "./config.js";
import { configureSandboxGit } from "./git-operations.js";
import { ensureSandboxDns } from "./sandbox-lifecycle.js";
import { emit } from "./task-state.js";

export function validateGreenfieldDraftSecrets(
  svc: TaskService,
  job: ScheduleJob,
): void {
  if (!job.createRepository && !job.autoCreateRepository) {
    return;
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error(
      "OPENAI_API_KEY is not set on the scheduler. Add it to AWS SSM as a SecureString at /<env>/platform/openai_api_key, then run sudo devin-infra sync-platform-config on the execution host.",
    );
  }
}

export function validateAgentSecrets(svc: TaskService, task: Task): void {
  if (task.agent === "cursor" && !process.env.CURSOR_API_KEY?.trim()) {
    throw new Error(
      "Cursor agent credentials are not configured on the execution host. Ask your platform admin to configure agent secrets.",
    );
  }

  if (task.agent === "claude" && !process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      "Claude agent credentials are not configured on the execution host. Ask your platform admin to configure agent secrets.",
    );
  }
}

export async function prepareDraft(
  svc: TaskService,
  task: Task,
  job: ScheduleJob,
): Promise<void> {
  emit(svc, "draft.started", task.id, "Generating code plan", {
    phase: "drafting",
    steps: 0,
  });

  const plan = await generateDraftPlan(
    {
      prompt: task.prompt,
      repository: job.repository ?? task.repository,
      createRepository: job.createRepository,
      hasTestCommand: Boolean(job.testCommand),
      agent: task.agent,
    },
    {
      onStep: async (step, index, total) => {
        emit(svc, "draft.updated", task.id, step, {
          phase: "drafting",
          step: index + 1,
          totalSteps: total,
        });
      },
      onFile: async (file, index, total) => {
        emit(svc, "draft.diff", task.id, `Planned change: ${file.path}`, {
          phase: "drafting",
          path: file.path,
          changeType: file.changeType,
          summary: file.summary,
          fileIndex: index + 1,
          totalFiles: total,
        });
      },
    },
  );

  job.draftPlan = plan;

  emit(svc, "draft.completed", task.id, "Draft plan ready", {
    phase: "draft_ready",
    files: plan.files,
    summary: plan.summary,
    steps: plan.steps,
  });
}

export async function provisionGreenfieldRepository(
  svc: TaskService,
  task: Task,
  job: ScheduleJob,
): Promise<void> {
  if (usesRuntimeAgent(task.agent)) {
    await provisionGreenfieldRepositoryShell(svc, task, job);
    return;
  }

  if (job.repository && job.cloneUrl) {
    return;
  }

  if (!job.createRepository && !job.autoCreateRepository) {
    return;
  }

  const githubToken = job.githubToken;
  if (!githubToken) {
    throw new Error("GitHub token is required for repository creation");
  }
  if (!job.permissions?.canCreateRepo) {
    throw new Error("repository creation is not permitted");
  }

  const metadata = generateProjectMetadata(task.prompt);
  task.title = metadata.title;

  const created = await createGitHubRepositoryUnique(githubToken, {
    description: metadata.description,
    preferredName: job.createRepository?.trim() || undefined,
  });

  const repository = created.fullName;
  const cloneUrl = authenticatedCloneUrl(githubToken, repository);
  job.repository = repository;
  job.cloneUrl = cloneUrl;
  task.repository = repository;

  emit(svc, "git.repo", task.id, `Created repository ${repository}`, {
    repository,
    htmlUrl: created.htmlUrl,
    repoName: created.name,
  });

  if (!job.permissions?.canPush) {
    return;
  }

  const plan =
    job.draftPlan ??
    ({
      summary: metadata.description,
      steps: [],
      files: [],
    } satisfies DraftPlan);

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`invalid repository name: ${repository}`);
  }

  const scaffoldFiles = scaffoldFilesFromDraft(plan, {
    title: task.title ?? metadata.title,
    prompt: task.prompt,
  });

  for (const [index, file] of scaffoldFiles.entries()) {
    emit(svc, "draft.diff", task.id, `Writing ${file.path}`, {
      phase: "draft_ready",
      path: file.path,
      changeType: "create",
      summary: `Scaffold file prepared for GitHub`,
      fileIndex: index + 1,
      totalFiles: scaffoldFiles.length,
      controlPlane: true,
    });
  }

  const commitMessage = buildCommitMessage(
    `devin: scaffold ${task.title ?? metadata.title}`,
  );

  emit(svc, "git.commit", task.id, "Pushing scaffold to GitHub", {
    repository,
    files: scaffoldFiles.map((file) => file.path),
    controlPlane: true,
  });

  await createGitHubInitialCommit(
    githubToken,
    owner,
    repo,
    scaffoldFiles,
    commitMessage,
    created.defaultBranch,
  );

  job.greenfieldPushed = true;
  svc.pendingJobs.set(task.id, job);

  emit(svc, "git.push", task.id, "Pushed scaffold to GitHub", {
    repository,
    branch: created.defaultBranch,
    controlPlane: true,
    files: scaffoldFiles.map((file) => file.path),
  });

  emit(svc, "task.phase_changed", task.id, "Scaffold live on GitHub", {
    phase: "draft_ready",
    repository,
    scaffoldPushed: true,
  });
}

export async function provisionGreenfieldRepositoryShell(
  svc: TaskService,
  task: Task,
  job: ScheduleJob,
): Promise<void> {
  if (job.repository && job.cloneUrl) {
    return;
  }

  if (!job.createRepository && !job.autoCreateRepository) {
    return;
  }

  const githubToken = job.githubToken;
  if (!githubToken) {
    throw new Error("GitHub token is required for repository creation");
  }
  if (!job.permissions?.canCreateRepo) {
    throw new Error("repository creation is not permitted");
  }

  const metadata = generateProjectMetadata(task.prompt);
  task.title = metadata.title;

  const created = await createGitHubRepositoryUnique(githubToken, {
    description: metadata.description,
    preferredName: job.createRepository?.trim() || undefined,
  });

  const repository = created.fullName;
  const cloneUrl = authenticatedCloneUrl(githubToken, repository);
  job.repository = repository;
  job.cloneUrl = cloneUrl;
  task.repository = repository;

  emit(svc, "git.repo", task.id, `Created repository ${repository}`, {
    repository,
    htmlUrl: created.htmlUrl,
    repoName: created.name,
    runtimeAgent: true,
  });

  if (!job.permissions?.canPush) {
    return;
  }

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`invalid repository name: ${repository}`);
  }

  const stackRuntime = resolveStackRuntime(task, job);
  const scaffoldFiles = greenfieldShellScaffoldFiles({
    title: task.title ?? metadata.title,
    prompt: task.prompt,
    stackRuntime,
  });
  const commitMessage = buildCommitMessage(
    `devin: initialize ${task.title ?? metadata.title}`,
  );

  emit(
    svc,
    "git.commit",
    task.id,
    "Creating greenfield repository scaffold on GitHub",
    {
      repository,
      controlPlane: true,
      runtimeAgent: true,
      files: scaffoldFiles.map((file) => file.path),
    },
  );

  await createGitHubInitialCommit(
    githubToken,
    owner,
    repo,
    scaffoldFiles,
    commitMessage,
    created.defaultBranch,
  );

  job.greenfieldPushed = true;
  svc.pendingJobs.set(task.id, job);

  emit(svc, "git.push", task.id, "Repository scaffold pushed to GitHub", {
    repository,
    branch: created.defaultBranch,
    controlPlane: true,
    runtimeAgent: true,
    files: scaffoldFiles.map((file) => file.path),
  });
}

export async function assertGreenfieldDeliverable(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  repoCwd: string,
  stackRuntime: StackRuntime,
): Promise<void> {
  const marker =
    stackRuntime === "go"
      ? "go.mod"
      : stackRuntime === "rust"
        ? "Cargo.toml"
        : stackRuntime === "python"
          ? "requirements.txt"
          : "package.json";

  const check = await runtime.terminal({
    taskId: task.id,
    cwd: repoCwd,
    command: `test -f '${escapeShell(marker)}' && echo yes || echo no`,
  });

  if (check.stdout.trim() !== "yes") {
    throw new Error(
      `Greenfield scaffold is missing a runnable ${stackRuntime} project (${marker} missing)`,
    );
  }
}

export async function cloneRepositoryInSandbox(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  cloneUrl: string,
  repoCwd: string,
  repository: string,
): Promise<void> {
  emit(svc, "git.clone", taskId, `Cloning ${repository} from GitHub`, {
    repository,
    fromRemote: true,
  });

  await ensureSandboxDns(svc, runtime, taskId);

  const attemptClone = async (): Promise<void> => {
    await runtime.gitClone({
      taskId,
      url: cloneUrl,
      path: repoCwd,
    });
  };

  try {
    await attemptClone();
  } catch (firstError) {
    if (!isNetworkCloneFailure(firstError)) {
      throw firstError;
    }
    emit(
      svc,
      "agent.log",
      taskId,
      "Git clone failed; refreshing sandbox DNS and retrying",
      { repository, retry: true },
    );
    await ensureSandboxDns(svc, runtime, taskId);
    await sleep(2_000);
    await attemptClone();
  }
}

export function buildGreenfieldShellReadme(
  svc: TaskService,
  task: Task,
): string {
  const metadata = generateProjectMetadata(task.prompt);
  const title = task.title ?? metadata.title;
  return `# ${title}\n\n${metadata.description}\n\n_Implementation will be generated by the runtime agent in the sandbox._\n`;
}

export {
  hydrateRepositoryShellInSandbox,
  alignHydratedRepoWithOriginMain,
  rebaseHydratedRepoOntoOriginMain,
} from "./greenfield-provision-hydrate.js";
