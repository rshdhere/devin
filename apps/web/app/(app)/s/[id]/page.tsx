import { SessionPage } from "@/components/dashboard/session-page";

interface SessionRouteProps {
  params: Promise<{ id: string }>;
}

export default async function SessionRoute({ params }: SessionRouteProps) {
  const { id } = await params;
  return <SessionPage sessionId={id} />;
}
