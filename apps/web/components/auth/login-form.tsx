"use client";

import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthDivider } from "@/components/auth/auth-divider";
import { SocialAuthButtons } from "@/components/auth/social-auth-buttons";
import { authClient } from "@/lib/auth-client";
import { getCallbackURL } from "@/lib/auth-config";
import { cn } from "@/lib/utils";

function getNameFromEmail(email: string) {
  const localPart = email.split("@")[0]?.trim();
  if (!localPart) {
    return "User";
  }

  return localPart.replace(/[^a-zA-Z0-9._-]/g, " ") || "User";
}

function getAuthErrorMessage(code: string | null) {
  switch (code) {
    case "new_user_signup_disabled":
      return "This email is not registered yet. Request a new sign-in link to create your account.";
    case "INVALID_TOKEN":
    case "token_expired":
      return "That sign-in link has expired. Request a new one below.";
    default:
      return code
        ? "We could not sign you in. Request a new link and try again."
        : null;
  }
}

export function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);

  useEffect(() => {
    setError(getAuthErrorMessage(searchParams.get("error")));
  }, [searchParams]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const { error: signInError } = await authClient.signIn.magicLink({
      email,
      name: getNameFromEmail(email),
      callbackURL: getCallbackURL("/s"),
      errorCallbackURL: getCallbackURL("/login"),
    });

    setIsSubmitting(false);

    if (signInError) {
      setError(signInError.message ?? "Unable to log in. Please try again.");
      return;
    }

    setEmailSent(true);
  };

  if (emailSent) {
    return (
      <div className="rounded-md border border-[#333] bg-[#1e1e1e] px-4 py-5 text-center">
        <p className="text-[15px] font-medium text-white">Check your email</p>
        <p className="mt-2 text-[14px] leading-relaxed text-gray-500">
          We sent a sign-in link to{" "}
          <span className="text-gray-300">{email}</span>. Click the link to
          continue to Devin.
        </p>
      </div>
    );
  }

  return (
    <>
      <SocialAuthButtons />

      <AuthDivider />

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="Email address"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={cn(
            "w-full rounded-md border border-[#333] bg-[#1a1a1a] px-4 py-3",
            "text-[15px] text-white placeholder:text-gray-500",
            "outline-none focus:border-[#4a90e2] focus:ring-1 focus:ring-[#4a90e2]",
          )}
        />

        {error ? (
          <p className="text-center text-[13px] text-red-400">{error}</p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className={cn(
            "w-full rounded-md bg-[#4a90e2] px-4 py-3 text-[15px] font-semibold text-white",
            "transition-colors hover:bg-[#3d7ec8] disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {isSubmitting ? "Sending link..." : "Log in"}
        </button>
      </form>
    </>
  );
}
