import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { LoadingScreen } from "@/components/loading-screen";

export const metadata: Metadata = {
  title: "Sessions — Devin",
  description: "Your Devin workspace",
  icons: {
    icon: "/apple-touch-icon.png",
    apple: "/apple-touch-icon.png",
  },
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-screen overflow-hidden">
      <Suspense fallback={<LoadingScreen />}>
        <DashboardPage>{children}</DashboardPage>
      </Suspense>
    </div>
  );
}
