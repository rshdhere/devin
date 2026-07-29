"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { LoadingScreen } from "@/components/loading-screen";
import { authClient } from "@/lib/auth-client";
import { getCallbackURL } from "@/lib/auth-config";
import { useMinimumLoadingDuration } from "@/lib/use-minimum-loading-duration";

export function AuthRedirectIfLoggedIn({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const minDurationElapsed = useMinimumLoadingDuration();

  useEffect(() => {
    if (isPending || !minDurationElapsed) {
      return;
    }

    if (session) {
      router.replace(getCallbackURL("/s"));
      return;
    }

    let cancelled = false;

    void (async () => {
      const refreshed = await authClient.getSession();
      if (cancelled || !refreshed.data) {
        return;
      }

      router.replace(getCallbackURL("/s"));
    })();

    return () => {
      cancelled = true;
    };
  }, [isPending, minDurationElapsed, router, session]);

  if (isPending || !minDurationElapsed || session) {
    return <LoadingScreen className="bg-[#121212]" />;
  }

  return children;
}
