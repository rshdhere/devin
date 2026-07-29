import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE_NAMES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

const PROTECTED_PREFIXES = [
  "/s",
  "/ask",
  "/automations",
  "/review",
  "/wiki",
  "/dashboard",
] as const;

function hasSessionCookie(request: NextRequest): boolean {
  return SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));
}

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isProtectedPath(pathname) && !hasSessionCookie(request)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/login" && hasSessionCookie(request)) {
    const sessionsUrl = request.nextUrl.clone();
    sessionsUrl.pathname = "/s";
    sessionsUrl.search = "";
    return NextResponse.redirect(sessionsUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/s",
    "/s/:path*",
    "/ask",
    "/ask/:path*",
    "/automations",
    "/automations/:path*",
    "/review",
    "/review/:path*",
    "/wiki",
    "/wiki/:path*",
    "/dashboard",
    "/dashboard/:path*",
    "/login",
  ],
};
