"use client";

import { useState, type ReactNode } from "react";
import { AuthDivider } from "@/components/auth/auth-divider";
import { authClient } from "@/lib/auth-client";
import { getCallbackURL } from "@/lib/auth-config";
import { cn } from "@/lib/utils";

const LOCAL_DEV_EMAIL = "local@devin.test";
const LOCAL_DEV_PASSWORD = "local-dev-access";

/**
 * TEMPLATE — copy to local-dev-login.local.tsx (gitignored) for local-only login.
 * Staging/prod keep the stub in local-dev-login.tsx and never see this button.
 */
export function LocalDevLoginSlot({
  disabled = false,
}: {
  disabled?: boolean;
}): ReactNode {
  const [isLocalSubmitting, setIsLocalSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLocalDevLogin = async () => {
    setIsLocalSubmitting(true);
    setError(null);

    const callbackURL = getCallbackURL("/s");

    const signedUp = await authClient.signUp.email({
      email: LOCAL_DEV_EMAIL,
      password: LOCAL_DEV_PASSWORD,
      name: "Local Dev",
      callbackURL,
    });

    if (!signedUp.error) {
      window.location.assign(callbackURL);
      return;
    }

    const signedIn = await authClient.signIn.email({
      email: LOCAL_DEV_EMAIL,
      password: LOCAL_DEV_PASSWORD,
      callbackURL,
    });

    setIsLocalSubmitting(false);

    if (signedIn.error) {
      setError(
        signedIn.error.message ??
          "Local login failed. Restart the API with ALLOW_LOCAL_DEV_LOGIN=true.",
      );
      return;
    }

    window.location.assign(callbackURL);
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled || isLocalSubmitting}
        onClick={() => void handleLocalDevLogin()}
        className={cn(
          "flex w-full cursor-pointer items-center justify-center rounded-md border border-emerald-500/30",
          "bg-emerald-500/10 px-4 py-3 text-[15px] font-medium text-emerald-100",
          "transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {isLocalSubmitting ? "Signing in…" : "Continue locally (dev)"}
      </button>
      {error ? (
        <p className="text-center text-[13px] text-red-400">{error}</p>
      ) : null}
      <AuthDivider />
    </>
  );
}
