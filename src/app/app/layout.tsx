import { Suspense } from "react";
import { OfflineSync } from "@/components/offline-sync";
import { Shell } from "@/components/shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="shell" aria-busy="true" />}>
      <Shell>
        <OfflineSync />
        {children}
      </Shell>
    </Suspense>
  );
}
