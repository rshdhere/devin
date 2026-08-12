import { usesRuntimeAgent } from "../../agent/defaults.js";
import {
  authenticatedCloneUrl,
  fetchGitHubUserIdentity,
} from "../../github/client.js";
import { bootstrapGreenfieldProject } from "../../greenfield/bootstrap.js";
import type { TaskEventType } from "@devin/types";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "../task-service.js";
import {
  isNetworkCloneFailure,
  resolveBotAuthor,
  resolveStackRuntime,
} from "../config.js";
import { configureSandboxGit } from "../git-operations.js";
import {
  assertGreenfieldDeliverable,
  cloneRepositoryInSandbox,
  hydrateRepositoryShellInSandbox,
} from "../greenfield-provision.js";
import {
  ensureSandboxConnectivity,
  hydrateGreenfieldInSandbox,
} from "../greenfield-provision-2.js";
import { ensureSandboxDns } from "../sandbox-lifecycle.js";
import { emit, emitRuntime } from "../task-state.js";
import type { ProcessJobState } from "./state.js";

export async function runSandboxRepoSetupPhase(
  svc: TaskService,
  job: ScheduleJob,
  task: Task,
  state: ProcessJobState,
  resumeSession: unknown,
): Promise<void> {
  if (!resumeSession) {
    state.repoCwd = "repo";
    state.repository = job.repository ?? task.repository;
    state.cloneUrl = job.cloneUrl;
    state.githubToken = job.githubToken;
    state.createdNewRepo =
      Boolean(job.greenfieldPushed) ||
      (usesRuntimeAgent(task.agent) &&
        Boolean(job.createRepository || job.autoCreateRepository));
    state.repoHydratedLocally = false;

    if (state.githubToken) {
      try {
        state.gitOwner = await fetchGitHubUserIdentity(state.githubToken);
      } catch {
        // commits still work with bot co-author trailer if identity lookup fails
      }
    }

    if (
      !state.repository &&
      (job.createRepository || job.autoCreateRepository)
    ) {
      throw new Error(
        "Repository was not provisioned before sandbox execution",
      );
    }

    if (
      state.repository &&
      state.githubToken &&
      !state.cloneUrl &&
      (job.autoCreateRepository || job.createRepository)
    ) {
      state.cloneUrl = authenticatedCloneUrl(
        state.githubToken,
        state.repository,
      );
      job.cloneUrl = state.cloneUrl;
      job.repository = state.repository;
      task.repository = state.repository;
      state.createdNewRepo = true;
    }

    if (state.cloneUrl && state.repository) {
      await ensureSandboxDns(svc, state.runtime, task.id);

      if (
        usesRuntimeAgent(task.agent) &&
        state.createdNewRepo &&
        job.greenfieldPushed
      ) {
        // Hydrate first — same files the control plane just pushed. Avoids
        // multi-minute git clone DNS failures that dominate greenfield latency.
        emit(
          svc,
          "agent.log",
          task.id,
          "Hydrating greenfield scaffold in sandbox (skip slow remote clone)",
          {
            repository: state.repository,
            runtimeAgent: true,
            hydrateFirst: true,
          },
        );
        await hydrateRepositoryShellInSandbox(
          svc,
          state.runtime,
          task,
          job,
          state.repoCwd,
          state.gitOwner,
          state.cloneUrl,
          state.githubToken,
        );
        state.repoHydratedLocally = true;
      } else if (
        job.greenfieldPushed &&
        job.draftPlan &&
        !usesRuntimeAgent(task.agent)
      ) {
        emit(
          svc,
          "agent.log",
          task.id,
          "Using local scaffold hydration for greenfield repo (skipping git clone)",
          { repository: state.repository, fallback: "hydrate" },
        );
        await hydrateGreenfieldInSandbox(
          svc,
          state.runtime,
          task,
          job,
          state.repoCwd,
          state.gitOwner,
          state.cloneUrl,
          state.githubToken,
        );
        state.repoHydratedLocally = true;
      } else {
        if (task.agent === "cursor") {
          await ensureSandboxConnectivity(svc, state.runtime, task.id);
        }
        try {
          await cloneRepositoryInSandbox(
            svc,
            state.runtime,
            task.id,
            state.cloneUrl,
            state.repoCwd,
            state.repository,
          );
        } catch (error) {
          if (
            job.draftPlan &&
            !usesRuntimeAgent(task.agent) &&
            isNetworkCloneFailure(error)
          ) {
            emit(
              svc,
              "agent.log",
              task.id,
              "Git clone failed in sandbox; hydrating from draft scaffold",
              { repository: state.repository, fallback: "hydrate" },
            );
            await hydrateGreenfieldInSandbox(
              svc,
              state.runtime,
              task,
              job,
              state.repoCwd,
              state.gitOwner,
              state.cloneUrl,
              state.githubToken,
            );
            state.repoHydratedLocally = true;
          } else {
            throw error;
          }
        }
      }
      if (!state.repoHydratedLocally) {
        await configureSandboxGit(svc, state.runtime, task.id, state.gitOwner, {
          repoCwd: state.repoCwd,
          cloneUrl: state.cloneUrl,
          githubToken: state.githubToken,
        });
      }
      if (usesRuntimeAgent(task.agent) && state.createdNewRepo) {
        await assertGreenfieldDeliverable(
          svc,
          state.runtime,
          task,
          state.repoCwd,
          resolveStackRuntime(task, job),
        );
      }
      if (
        !job.greenfieldPushed &&
        state.createdNewRepo &&
        !usesRuntimeAgent(task.agent)
      ) {
        const bot = resolveBotAuthor();
        try {
          await bootstrapGreenfieldProject({
            runtime: state.runtime,
            taskId: task.id,
            repoCwd: state.repoCwd,
            prompt: task.prompt,
            stackRuntime: resolveStackRuntime(task, job),
            title: task.title ?? "project",
            botName: bot.name,
            botEmail: bot.email,
            canPush: Boolean(job.permissions?.canPush),
            githubToken: state.githubToken,
            cloneUrl: state.cloneUrl,
            emit: (type, message, data) =>
              emitRuntime(svc, task.id, type as TaskEventType, message, data),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Bootstrap failed";
          emit(svc, "git.commit", task.id, `Bootstrap failed: ${message}`, {
            error: message,
            bootstrap: true,
          });
          throw error;
        }
      }
    } else if (state.githubToken) {
      await configureSandboxGit(svc, state.runtime, task.id, state.gitOwner, {
        githubToken: state.githubToken,
      });
    }
  }

  if (!state.gitOwner && state.githubToken) {
    try {
      state.gitOwner = await fetchGitHubUserIdentity(state.githubToken);
    } catch {
      // optional for follow-up prompts
    }
  }
}
