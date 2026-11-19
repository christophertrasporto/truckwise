import type { Metadata } from "next";
import Link from "next/link";
import { requireSignedIn } from "@/server/auth/current";
import { platformActivity } from "@/server/services/admin";
import { formatDateTime } from "@/shared/format";

export const metadata: Metadata = { title: "Platform activity" };

const LABEL: Record<string, string> = {
  "company.create": "Company created",
  "company.suspend": "Company suspended",
  "company.reactivate": "Company reactivated",
  "plan.create": "Plan created",
  "plan.update": "Plan changed",
  "subscription.change_plan": "Company moved to another plan",
  "subscription.payment": "Subscription payment recorded",
  "subscription.expired": "Subscription expired (company suspended)",
  "application_link.create": "Application link created",
  "partner.invite": "Subcontractor added",
};

export default async function ActivityPage() {
  const actor = await requireSignedIn();
  if (!actor.isPlatformAdmin) return <div className="empty">This area is for the platform administrator.</div>;
  const rows = await platformActivity(actor);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="muted" style={{ margin: 0 }}><Link href="/app/admin">← Platform</Link></p>
          <h1>Platform activity</h1>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="empty">Nothing yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 560 }}>
            <thead><tr><th>When</th><th>What</th><th>Company</th><th>By</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}><td>{formatDateTime(r.at)}</td><td>{LABEL[r.action] ?? r.action}</td><td>{r.company ?? "-"}</td><td>{r.by ?? "system"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
