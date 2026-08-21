import { RuntimeClient, type RunResponse } from "@devin/agent-sdk";
import { usesRuntimeAgent } from "../../../agent/defaults.js";
import { buildPruneWorkspaceDiskScript } from "../../../devbox/preview.js";
import { isRecoverableAgentInterruption } from "../../../greenfield/git-sync.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "../task-service.js";
import {
  buildAgentPrompt,
  vercelDeploymentRequested,
} from "../agent-prompt.js";
import { resolveAgentMaxWaitMs, resolveStackRuntime } from "../config.js";
import {
  schedulePostCompletionDesktopCapture,
  startDevboxPreviewWatcher,
} from "../desktop-capture.js";
import {
  assertGreenfieldAgentProgress,
  createTaskIssue,
  finalizeGitWork,
  forwardRuntimeEvents,
  gitRuntimeEnv,
  readGitHead,
  runTests,
  runtimeSecrets,
  startAutoCommitWatcher,
  startGreenfieldPushWatcher,
} from "../git-operations.js";
import {
  ensureBashInSandbox,
  ensureCursorAgentInSandbox,
  ensureSandboxConnectivity,
  recoverGreenfieldAfterAgentInterruption,
  runTemplateGreenfieldVerify,
  startWorkspaceDiskPruneWatcher,
} from "../greenfield-provision-2.js";
import { persistSession } from "../persistence.js";
import { emit, emitRuntime, patchTask, updateTask } from "../task-state.js";
import { persistTaskContextMemory } from "../../../context/session-context.js";
import type { ProcessJobState } from "./state.js";

export async function runAgentPhase(
  svc: TaskService,
  job: ScheduleJob,
  task: Task,
  state: ProcessJobState,
): Promise<void> {
  const agentPrompt = buildAgentPrompt(
    job.prompt,
    state.repository ?? "workspace repository",
    state.repoCwd,
    state.gitOwner,
    resolveStackRuntime(task, job),
    {
      followUp: job.resumeSession === true,
      greenfieldRepo: state.createdNewRepo,
      sessionContext: job.sessionContext,
      sessionRecovery: job.recoverSession === true,
    },
  );
  const repoReadyInSandbox = Boolean(state.repository && state.cloneUrl);

  const isTemplateGreenfield =
    task.agent === "mock" && Boolean(job.greenfieldPushed);
  const runtimeAgentTask = usesRuntimeAgent(task.agent);

  // Runtime agents own git history; auto-checkpoints fight them and cause
  // divergent main + repeated push rejections during long cursor runs.
  const stopAutoCommit =
    state.repository &&
    state.cloneUrl &&
    !isTemplateGreenfield &&
    !runtimeAgentTask
      ? startAutoCommitWatcher(
          svc,
          state.runtime,
          task,
          job,
          state.repoCwd,
          state.gitOwner,
          state.createdNewRepo,
          state.githubToken,
        )
      : () => undefined;

  const stopEvents = forwardRuntimeEvents(svc, state.runtimeBaseUrl, task.id);

  // Always verify egress for cursor — hydrate-first greenfield still needs
  // api2.cursor.sh, and must not skip DNS just because clone was skipped.
  if (task.agent === "cursor") {
    await ensureSandboxConnectivity(svc, state.runtime, task.id);
  }

  const preAgentHead =
    state.createdNewRepo && runtimeAgentTask && state.runtime
      ? await readGitHead(
          svc,
          state.runtime,
          task.id,
          state.repoCwd,
          state.githubToken,
        )
      : "";

  const greenfieldSoftAbort = { reason: undefined as string | undefined };
  const stopGreenfieldPush =
    state.createdNewRepo &&
    runtimeAgentTask &&
    state.repository &&
    state.cloneUrl &&
    job.permissions?.canPush
      ? startGreenfieldPushWatcher(
          svc,
          state.runtime,
          task.id,
          job,
          state.repoCwd,
          state.githubToken,
          preAgentHead,
          (reason) => {
            greenfieldSoftAbort.reason = reason;
          },
        )
      : () => undefined;

  const stopDevboxPreview = startDevboxPreviewWatcher(svc, task.id);
  const stopDiskPrune = startWorkspaceDiskPruneWatcher(
    svc,
    state.runtime,
    task.id,
  );

  await state.runtime.terminalAllowFailure({
    taskId: task.id,
    command: buildPruneWorkspaceDiskScript(),
  });

  if (!state.runtime || !state.runtimeBaseUrl || !state.sandboxName) {
    throw new Error("devbox session is not available before agent start");
  }

  // Register the session before the agent starts so Shell / Files / Browser
  // proxy routes work during the run (not only after completion).
  svc.activeSessions.set(task.id, {
    runtime: state.runtime,
    sandboxName: state.sandboxName,
    runtimeBaseUrl: state.runtimeBaseUrl,
    repoCwd: state.repoCwd,
    job,
    githubToken: state.githubToken,
    createdNewRepo: state.createdNewRepo,
    guestHost: state.guestHost,
  });
  void persistSession(svc, task.id, svc.activeSessions.get(task.id)!, "active");
  task.sessionActive = true;
  patchTask(svc, task.id, {
    sessionActive: true,
    sandboxName: state.sandboxName,
  });

  updateTask(
    svc,
    task.id,
    "running",
    isTemplateGreenfield
      ? "Verifying scaffold in sandbox"
      : `${task.agent} agent executing task`,
  );
  emit(svc, "task.phase_changed", task.id, "Agent executing in devbox", {
    phase: "running",
    sessionActive: true,
    agent: task.agent,
  });
  emit(
    svc,
    "agent.running",
    task.id,
    isTemplateGreenfield
      ? "Template execution started (OpenAI scaffold)"
      : `${task.agent} agent started`,
    {
      prompt: task.prompt,
      agent: task.agent,
      repository: state.repository,
      templateGreenfield: isTemplateGreenfield,
      sessionActive: true,
    },
  );

  let runResult: RunResponse;
  try {
    if (isTemplateGreenfield) {
      runResult = await runTemplateGreenfieldVerify(
        svc,
        state.runtime,
        task,
        state.repoCwd,
        resolveStackRuntime(task, job),
      );
    } else {
      if (task.agent === "cursor" && state.runtime) {
        await ensureBashInSandbox(svc, state.runtime, task.id);
        await ensureCursorAgentInSandbox(svc, state.runtime, task.id);
      }
      if (vercelDeploymentRequested(job.prompt)) {
        const vercelCli = await state.runtime.terminalAllowFailure({
          taskId: task.id,
          cwd: state.repoCwd,
          command: "npx --yes vercel --version",
        });
        if (vercelCli.exitCode !== 0) {
          throw new Error(
            `Vercel CLI bootstrap failed: ${(vercelCli.stderr || vercelCli.stdout).trim() || "npx could not install or run vercel"}`,
          );
        }
        emit(svc, "agent.log", task.id, "Vercel CLI ready in microVM", {
          vercelCli: (vercelCli.stdout || vercelCli.stderr).trim(),
        });
      }
      runResult = await state.runtime.runAndWait(
        {
          taskId: task.id,
          prompt: agentPrompt,
          agent: task.agent,
          workDir: repoReadyInSandbox ? state.repoCwd : undefined,
          env: runtimeSecrets(
            svc,
            state.githubToken,
            task.agent,
            job.agentModel,
          ),
        },
        {
          maxWaitMs: resolveAgentMaxWaitMs(),
          getAbortReason: () => greenfieldSoftAbort.reason,
        },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed";
    if (isRecoverableAgentInterruption(message)) {
      emit(svc, "agent.failed", task.id, message, {
        timeout:
          /timed out|did not finish within|idle-stalled|commit-plateau/i.test(
            message,
          ),
        resourceExhausted:
          /resource_exhausted|RetriableError|rate.?limit|quota/i.test(message),
        maxWaitMs: resolveAgentMaxWaitMs(),
      });
      if (
        state.createdNewRepo &&
        runtimeAgentTask &&
        state.runtime &&
        state.repository &&
        state.cloneUrl
      ) {
        const recovered = await recoverGreenfieldAfterAgentInterruption(
          svc,
          state.runtime,
          task,
          job,
          state.repoCwd,
          state.githubToken,
          preAgentHead,
        );
        if (recovered) {
          runResult = {
            status: "completed",
            taskId: task.id,
            message:
              "Agent interrupted; control plane finalized greenfield commits",
            agent: task.agent,
          };
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  } finally {
    stopAutoCommit();
    stopGreenfieldPush();
    stopDevboxPreview();
    stopDiskPrune();
    stopEvents();
  }

  if (runResult.status === "failed") {
    const failMessage = runResult.message || "Agent run failed";
    if (
      isRecoverableAgentInterruption(failMessage) &&
      state.createdNewRepo &&
      runtimeAgentTask &&
      state.runtime &&
      state.repository &&
      state.cloneUrl
    ) {
      emit(svc, "agent.failed", task.id, failMessage, {
        timeout:
          /timed out|did not finish within|idle-stalled|commit-plateau/i.test(
            failMessage,
          ),
        idleStalled: /idle-stalled/i.test(failMessage),
        resourceExhausted:
          /resource_exhausted|RetriableError|rate.?limit|quota/i.test(
            failMessage,
          ),
        maxWaitMs: resolveAgentMaxWaitMs(),
      });
      const recovered = await recoverGreenfieldAfterAgentInterruption(
        svc,
        state.runtime,
        task,
        job,
        state.repoCwd,
        state.githubToken,
        preAgentHead,
      );
      if (recovered) {
        runResult = {
          status: "completed",
          taskId: task.id,
          message:
            "Agent interrupted; control plane finalized greenfield commits",
          agent: task.agent,
        };
      } else {
        throw new Error(failMessage);
      }
    } else {
      throw new Error(failMessage);
    }
  }

  if (state.createdNewRepo && runtimeAgentTask && state.runtime) {
    await assertGreenfieldAgentProgress(
      svc,
      state.runtime,
      task,
      state.repoCwd,
      state.githubToken,
      preAgentHead,
    );
  }

  if (
    runtimeAgentTask &&
    state.repository &&
    state.cloneUrl &&
    state.runtime &&
    state.sandboxName &&
    state.runtimeBaseUrl &&
    job.requireReviewBeforePush === true
  ) {
    const diffStat = await state.runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: state.repoCwd,
      command: "git diff --stat && git diff --cached --stat",
      env: gitRuntimeEnv(svc, state.githubToken),
    });

    svc.reviewSessions.set(task.id, {
      runtime: state.runtime,
      sandboxName: state.sandboxName,
      runtimeBaseUrl: state.runtimeBaseUrl,
      repoCwd: state.repoCwd,
      job,
      githubToken: state.githubToken,
      createdNewRepo: state.createdNewRepo,
      guestHost: state.guestHost,
    });
    void persistSession(
      svc,
      task.id,
      svc.reviewSessions.get(task.id)!,
      "review",
    );

    state.pausedForReview = true;
    state.retainSandboxForPreview = true;
    task.sessionActive = true;
    updateTask(
      svc,
      task.id,
      "awaiting_review",
      "Review agent changes, then commit or open a PR",
    );
    emit(svc, "task.phase_changed", task.id, "Agent work ready for review", {
      phase: "awaiting_review",
      awaitingReview: true,
      diff: diffStat.stdout.trim() || undefined,
      agent: task.agent,
      sessionActive: true,
    });
    if (diffStat.stdout.trim()) {
      emit(svc, "git.commit", task.id, "Uncommitted agent changes in devbox", {
        auto: false,
        awaitingReview: true,
        diff: diffStat.stdout.trim(),
      });
    }
    return;
  }

  let pushedToGitHub = false;
  if (state.repository && state.cloneUrl) {
    if (job.testCommand) {
      await runTests(svc, state.runtime, task, job.testCommand, state.repoCwd);
    }

    if (job.permissions) {
      pushedToGitHub = await finalizeGitWork(
        svc,
        state.runtime,
        task,
        job,
        state.repoCwd,
        state.githubToken,
        {
          greenfield: state.createdNewRepo,
          createPullRequest:
            job.requireReviewBeforePush === true ||
            !(state.createdNewRepo && runtimeAgentTask),
        },
      );
    }

    if (
      job.issueTitle &&
      job.permissions?.canCreateIssue &&
      state.githubToken &&
      state.repository
    ) {
      await createTaskIssue(
        svc,
        task,
        state.repository,
        state.githubToken,
        job,
      );
    }
  }

  const completionMessage =
    state.repository && state.cloneUrl
      ? pushedToGitHub
        ? "Work completed — pushed to GitHub"
        : "Work completed — local commits not pushed to GitHub"
      : runResult.message || "Task completed";

  task.pushedToGitHub = pushedToGitHub;
  const sessionBeforeComplete =
    svc.activeSessions.get(task.id) ?? svc.reviewSessions.get(task.id);

  // Include the retained runtime session in the same task write as completion.
  // Persisting `completed` first with sessionActive=false can race the later
  // patch and make a worker unable to rehydrate the still-running devbox.
  if (
    usesRuntimeAgent(task.agent) &&
    state.runtime &&
    state.sandboxName &&
    state.runtimeBaseUrl
  ) {
    task.sessionActive = true;
    task.sessionSleeping = false;
    task.sandboxName = state.sandboxName;
  }
  updateTask(svc, task.id, "completed", completionMessage);
  emit(svc, "task.completed", task.id, completionMessage, {
    output: runResult.output,
    agent: runResult.agent ?? task.agent,
    prUrl: task.prUrl,
    branch: task.branch,
    pushedToGitHub,
    sessionActive: usesRuntimeAgent(task.agent),
  });
  void (async () => {
    const stored = await svc.taskStore.loadEvents(task.id);
    const events = stored.length > 0 ? stored : svc.getEventHistory(task.id);
    await persistTaskContextMemory(task, events, completionMessage);
  })();

  if (
    usesRuntimeAgent(task.agent) &&
    state.runtime &&
    state.sandboxName &&
    state.runtimeBaseUrl
  ) {
    svc.activeSessions.set(task.id, {
      runtime: state.runtime,
      sandboxName: state.sandboxName,
      runtimeBaseUrl: state.runtimeBaseUrl,
      repoCwd: state.repoCwd,
      job,
      githubToken: state.githubToken,
      createdNewRepo: state.createdNewRepo,
      guestHost: state.guestHost,
      // Preserve preview state so post-complete Desktop captures work.
      devboxPreviewPort: sessionBeforeComplete?.devboxPreviewPort,
      lastDesktopScreenshot: sessionBeforeComplete?.lastDesktopScreenshot,
    });
    await persistSession(
      svc,
      task.id,
      svc.activeSessions.get(task.id)!,
      "active",
    );
    await svc.taskStore.touchSession(task.id);
    task.sessionActive = true;
    patchTask(svc, task.id, { sessionActive: true });
    state.retainSandboxForPreview = true;

    if (pushedToGitHub) {
      const shotSession = svc.activeSessions.get(task.id)!;
      schedulePostCompletionDesktopCapture(
        svc,
        shotSession,
        task,
        state.repoCwd,
        runtimeAgentTask,
      );
    }
  } else if (sessionBeforeComplete) {
    if (pushedToGitHub) {
      schedulePostCompletionDesktopCapture(
        svc,
        sessionBeforeComplete,
        task,
        state.repoCwd,
        runtimeAgentTask,
      );
    }
  }
}
