export const navItems = [
  { id: "sessions", label: "Sessions", href: "/s" },
  { id: "ask", label: "Ask", href: "/ask" },
  { id: "automations", label: "Automations", href: "/automations" },
  { id: "review", label: "Review", href: "/review" },
  { id: "wiki", label: "Wiki", href: "/wiki" },
] as const;

export type NavId = (typeof navItems)[number]["id"];

export const recentEmptyLabels: Record<NavId, string> = {
  sessions: "No sessions",
  ask: "No asks",
  automations: "No automations",
  review: "",
  wiki: "No wikis",
};

export function navIdFromPathname(pathname: string): NavId {
  if (pathname === "/ask" || pathname.startsWith("/ask/")) {
    return "ask";
  }
  if (pathname === "/automations" || pathname.startsWith("/automations/")) {
    return "automations";
  }
  if (pathname === "/review" || pathname.startsWith("/review/")) {
    return "review";
  }
  if (pathname === "/wiki" || pathname.startsWith("/wiki/")) {
    return "wiki";
  }
  return "sessions";
}

export function sessionIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/s\/([^/]+)\/?$/);
  return match?.[1] ?? null;
}
