import type { Metadata } from "next";
import { Suspense } from "react";
import { requireSignedIn } from "@/server/auth/current";
import { suspendedCompaniesFor } from "@/server/services/entitlements";

export const metadata: Metadata = { title: "Account" };

async function Notice() {
  const actor = await requireSignedIn();
  const suspended = await suspendedCompaniesFor(actor.userId);
  if (suspended.length > 0) {
    return (
      <div className="panel stack" role="status">
        <h1>Your company&apos;s access is paused</h1>
        {suspended.map((c) => (
          <p key={c.name}>
            <b>{c.name}</b> is suspended{c.since ? `; its subscription ended ${c.since.toISOString().slice(0, 10)}` : ""}. Contact the platform administrator to renew. Everything is kept safe and comes back as soon as the subscription is renewed.
          </p>
        ))}
      </div>
    );
  }
  return <div className="empty">Your account is not linked to a company. Ask an administrator to add you.</div>;
}

export default function NoCompany() {
  return (
    <Suspense fallback={null}>
      <Notice />
    </Suspense>
  );
}
