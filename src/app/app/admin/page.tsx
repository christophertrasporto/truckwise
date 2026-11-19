import type { Metadata } from "next";
import Link from "next/link";
import { requireSignedIn } from "@/server/auth/current";
import { listCompanies, listPlans, platformDashboard } from "@/server/services/admin";
import { formatDateTime, formatPeso } from "@/shared/format";
import { CreateCompanyForm } from "./admin-forms";

export const metadata: Metadata = { title: "Platform" };

export default async function AdminPage() {
  const actor = await requireSignedIn();
  if (!actor.isPlatformAdmin) return <div className="empty">This area is for the platform administrator.</div>;
  const [dash, companies, plans] = await Promise.all([platformDashboard(actor), listCompanies(actor), listPlans(actor)]);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Platform</h1>
        <div className="actions">
          <Link className="btn btn-ghost btn-sm" href="/app/admin/plans">Plans</Link>
          <Link className="btn btn-ghost btn-sm" href="/app/admin/activity">Activity</Link>
        </div>
      </div>

      <section className="panel" aria-label="Overview">
        <dl className="kv">
          <div><dt>Trucking companies</dt><dd>{dash.haulers}</dd></div>
          <div><dt>Subcontractor companies</dt><dd>{dash.subcontractors}</dd></div>
          <div><dt>Suspended</dt><dd>{dash.suspended}</dd></div>
          <div><dt>Paying</dt><dd>{dash.subscriptions.active ?? 0}</dd></div>
          <div><dt>On trial</dt><dd>{dash.subscriptions.trialing ?? 0}</dd></div>
          <div><dt>Expired</dt><dd>{dash.subscriptions.expired ?? 0}</dd></div>
          <div><dt>Monthly recurring revenue</dt><dd>{formatPeso(dash.monthlyRecurringCentavos)}</dd></div>
        </dl>
      </section>

      {dash.expiringSoon.length > 0 && (
        <section className="panel stack" aria-label="Ending soon">
          <h2>Ending in the next 14 days</h2>
          <ul>
            {dash.expiringSoon.map((e) => (
              <li key={e.id}><Link href={`/app/admin/companies/${e.id}`}>{e.name}</Link> ({e.status}) until {formatDateTime(e.periodEnd)}</li>
            ))}
          </ul>
        </section>
      )}

      <div style={{ overflowX: "auto" }}>
        <table className="table" style={{ minWidth: 720 }}>
          <thead><tr><th>Company</th><th>Type</th><th>Plan</th><th>Subscription ends</th><th>People</th><th>Trucks</th><th>Status</th></tr></thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/app/admin/companies/${c.id}`}>{c.name}</Link></td>
                <td>{c.kind === "hauler" ? "Trucking" : "Subcontractor"}</td>
                <td>{c.plan ?? "No plan (not limited)"}</td>
                <td>{c.periodEnd ? formatDateTime(c.periodEnd) : "-"}</td>
                <td>{c.users}</td>
                <td>{c.trucks}</td>
                <td><span className={c.status === "active" ? "chip chip-ok" : "chip chip-bad"}>{c.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateCompanyForm plans={plans.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }))} />
    </div>
  );
}
