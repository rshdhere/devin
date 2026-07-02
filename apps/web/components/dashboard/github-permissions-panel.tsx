"use client";

import { useEffect, useState } from "react";
import {
  Check,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Loader2,
  PlusCircle,
  Shield,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { getCallbackURL } from "@/lib/auth-config";
import {
  fetchGitHubStatusSafe,
  GITHUB_REPO_SCOPES,
  updateGitHubPermissions,
  type GitHubPermissions,
  type GitHubStatus,
} from "@/lib/github-api";
import { MotionButton } from "@/components/dashboard/motion-button";
import { DEVIN_BOT, displayBotUsername } from "@/lib/devin-bot";
import { cn } from "@/lib/utils";

interface GitHubPermissionsPanelProps {
  compact?: boolean;
}

const permissionItems = [
  {
    key: "canCommit" as const,
    label: "Commit changes",
    description: "Allow Devin to commit code in your repository",
    icon: GitCommit,
  },
  {
    key: "canPush" as const,
    label: "Push branches",
    description: "Push agent branches to your remote repository",
    icon: GitBranch,
  },
  {
    key: "canCreatePr" as const,
    label: "Open pull requests",
    description: "Create PRs after Devin finishes work",
    icon: GitPullRequest,
  },
  {
    key: "canCreateRepo" as const,
    label: "Create repositories",
    description:
      "Let baby-devin-bot create new GitHub repos for greenfield tasks",
    icon: PlusCircle,
  },
  {
    key: "canCreateIssue" as const,
    label: "Create issues",
    description: "Open GitHub issues for follow-ups and task tracking",
    icon: CircleDot,
  },
];

export function GitHubPermissionsPanel({
  compact = false,
}: GitHubPermissionsPanelProps) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchGitHubStatusSafe()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not load GitHub connection");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleConnect() {
    setIsConnecting(true);
    setError(null);

    try {
      await authClient.linkSocial({
        provider: "github",
        scopes: [...GITHUB_REPO_SCOPES, "read:user", "user:email"],
        callbackURL: getCallbackURL("/dashboard"),
      });
    } catch {
      setError("Failed to connect GitHub. Please try again.");
      setIsConnecting(false);
    }
  }

  async function handleRequestRepoAccess() {
    setIsConnecting(true);
    setError(null);

    try {
      await authClient.linkSocial({
        provider: "github",
        scopes: ["repo"],
        callbackURL: getCallbackURL("/dashboard"),
      });
    } catch {
      setError("Failed to request repository access. Please try again.");
      setIsConnecting(false);
    }
  }

  async function togglePermission(key: keyof GitHubPermissions) {
    if (!status) {
      return;
    }

    const next: GitHubPermissions = {
      ...status.permissions,
      [key]: !status.permissions[key],
    };

    setIsSaving(true);
    setError(null);

    try {
      const result = await updateGitHubPermissions(next);
      setStatus((current) =>
        current ? { ...current, permissions: result.permissions } : current,
      );
    } catch {
      setError("Failed to update permissions");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6 text-gray-500">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  if (!status?.connected) {
    return (
      <div
        className={cn(
          "rounded-xl border border-[#2a2a2a] bg-[#141414]",
          compact ? "p-4" : "p-5",
        )}
      >
        <div className="flex items-start gap-3">
          <Shield className="mt-0.5 size-5 shrink-0 text-[#4a90e2]" />
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-medium text-white">
              Connect your GitHub
            </h3>
            <p className="mt-1 text-[13px] text-gray-500">
              Link your personal GitHub account so Devin can work on your
              repositories, commit changes, and open pull requests.
            </p>
            <MotionButton
              type="button"
              pressStyle="primary"
              disabled={isConnecting}
              onClick={handleConnect}
              className="mt-3 cursor-pointer rounded-lg bg-[#4a90e2] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#3d7ec8] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isConnecting ? "Redirecting…" : "Connect GitHub"}
            </MotionButton>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-[#252525] bg-[#111] px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <img
                src={DEVIN_BOT.avatarUrl}
                alt=""
                className="mt-0.5 size-8 rounded-full border border-[#333]"
              />
              <div className="min-w-0">
                <p className="text-[13px] text-gray-200">
                  Platform bot:{" "}
                  <a
                    href={DEVIN_BOT.profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-[#5a9fd4] hover:underline"
                  >
                    @{displayBotUsername(status?.bot.username)}
                  </a>
                </p>
                <p className="text-[11px] text-gray-600">
                  Creates new repos and handles greenfield tasks on your behalf
                </p>
              </div>
            </div>
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-medium",
                status?.bot.configured
                  ? "bg-emerald-500/10 text-emerald-400"
                  : "bg-amber-500/10 text-amber-400",
              )}
            >
              {status?.bot.configured ? "Ready" : "Not configured"}
            </span>
          </div>
        </div>

        {error ? (
          <p className="mt-3 text-[12px] text-red-400">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-[#2a2a2a] bg-[#141414]",
        compact ? "p-4" : "p-5",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-medium text-white">
            GitHub permissions
          </h3>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Connected as{" "}
            <span className="text-gray-300">@{status.username}</span>
          </p>
        </div>
        {status.hasRepoAccess ? (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
            <Check className="size-3" />
            Repo access
          </span>
        ) : (
          <MotionButton
            type="button"
            disabled={isConnecting}
            onClick={handleRequestRepoAccess}
            className="cursor-pointer rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[12px] text-gray-300 transition-colors hover:bg-[#222] disabled:cursor-not-allowed"
          >
            {isConnecting ? "Redirecting…" : "Grant repo access"}
          </MotionButton>
        )}
      </div>

      <div className="mt-4 space-y-2">
        {permissionItems.map((item) => {
          const Icon = item.icon;
          const enabled = status.permissions[item.key];
          const isBotRequired = item.key === "canCreateRepo";
          const botUnavailable = isBotRequired && !status.bot.configured;
          const disabled = isSaving || !status.hasRepoAccess || botUnavailable;

          return (
            <div
              key={item.key}
              className={cn(
                "flex items-center justify-between gap-3 rounded-lg border border-[#252525] bg-[#111] px-3 py-2.5",
                botUnavailable && "opacity-60",
              )}
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <Icon className="mt-0.5 size-4 shrink-0 text-gray-500" />
                <div className="min-w-0">
                  <p className="text-[13px] text-gray-200">{item.label}</p>
                  {!compact ? (
                    <p className="text-[11px] text-gray-600">
                      {botUnavailable
                        ? "Platform bot not configured by admin"
                        : item.description}
                    </p>
                  ) : null}
                </div>
              </div>
              <MotionButton
                type="button"
                disabled={disabled}
                onClick={() => togglePermission(item.key)}
                className={cn(
                  "relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  enabled && !botUnavailable ? "bg-[#4a90e2]" : "bg-[#333]",
                )}
                aria-label={`Toggle ${item.label}`}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                    enabled && !botUnavailable ? "left-[18px]" : "left-0.5",
                  )}
                />
              </MotionButton>
            </div>
          );
        })}
      </div>

      {status.selectedRepository ? (
        <p className="mt-3 text-[12px] text-gray-500">
          Active repo:{" "}
          <a
            href={`https://github.com/${status.selectedRepository}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[#5a9fd4] hover:text-[#6aa8ef]"
          >
            {status.selectedRepository}
            <ExternalLink className="size-3" />
          </a>
        </p>
      ) : null}

      <div
        className={cn(
          "mt-4 rounded-lg border px-3 py-2.5",
          status.bot.configured
            ? "border-[#252525] bg-[#111]"
            : "border-amber-500/30 bg-amber-500/5",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[13px] text-gray-200">
              Platform bot: @{status.bot.username}
            </p>
            <p className="text-[11px] text-gray-600">
              {status.bot.configured
                ? "Used for new repo creation when no repository is selected"
                : "Bot token not set. Contact admin to enable repo creation."}
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] font-medium",
              status.bot.configured
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-amber-500/10 text-amber-400",
            )}
          >
            {status.bot.configured ? "Ready" : "Not configured"}
          </span>
        </div>
      </div>

      {error ? <p className="mt-3 text-[12px] text-red-400">{error}</p> : null}
    </div>
  );
}
