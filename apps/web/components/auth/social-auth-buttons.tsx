"use client";

import { useState } from "react";
import {
  GitHubIcon,
  GoogleIcon,
  WindsurfIcon,
} from "@/components/auth/auth-icons";
import { authClient } from "@/lib/auth-client";
import { getCallbackURL } from "@/lib/auth-config";
import { cn } from "@/lib/utils";

interface SocialAuthButtonsProps {
  callbackURL?: string;
}

const socialProviders = [
  {
    id: "github",
    label: "Continue with GitHub",
    icon: GitHubIcon,
    type: "social" as const,
    provider: "github" as const,
  },
  {
    id: "google",
    label: "Continue with Google",
    icon: GoogleIcon,
    type: "social" as const,
    provider: "google" as const,
  },
  {
    id: "windsurf",
    label: "Continue with Windsurf",
    icon: WindsurfIcon,
    type: "oauth2" as const,
    providerId: "windsurf",
  },
];

export function SocialAuthButtons({ callbackURL }: SocialAuthButtonsProps) {
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSocialSignIn = async (
    provider: (typeof socialProviders)[number],
  ) => {
    setLoadingProvider(provider.id);
    setError(null);

    const targetCallbackURL = callbackURL ?? getCallbackURL("/s");

    try {
      if (provider.type === "social") {
        await authClient.signIn.social({
          provider: provider.provider,
          callbackURL: targetCallbackURL,
        });
        return;
      }

      await authClient.signIn.oauth2({
        providerId: provider.providerId,
        callbackURL: targetCallbackURL,
      });
    } catch {
      setError("Unable to sign in with this provider. Please try again.");
      setLoadingProvider(null);
    }
  };

  return (
    <div className="space-y-3">
      {socialProviders.map((provider) => {
        const Icon = provider.icon;
        const isLoading = loadingProvider === provider.id;

        return (
          <button
            key={provider.id}
            type="button"
            disabled={loadingProvider !== null}
            onClick={() => handleSocialSignIn(provider)}
            className={cn(
              "flex w-full items-center justify-center gap-3 rounded-md border border-[#333]",
              "bg-[#1e1e1e] px-4 py-3 text-[15px] font-medium text-white",
              "cursor-pointer transition-colors hover:bg-[#252525] disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            <Icon />
            {isLoading ? "Redirecting..." : provider.label}
          </button>
        );
      })}

      {error ? (
        <p className="text-center text-[13px] text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
