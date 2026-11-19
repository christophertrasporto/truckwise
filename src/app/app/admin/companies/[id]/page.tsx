import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireSignedIn } from "@/server/auth/current";
import { getCompany, listPlans } from "@/server/services/admin";
import { formatDateTime, formatPeso } from "@/shared/format";
import { CompanyActions } from "../../admin-forms";

export const metadata: Metadata = { title: "Company" };

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireSignedIn();
  if (!actor.isPlatformAdmin) return <div className="empty">This area is for the platform administrator.</div>;
  const [c, plans] = await Promise.all([getCompany(actor, id), listPlans(actor)]);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="muted" style={{ margin: 0 }}><Link href="/app/admin">← Platform</Link></p>
          <h1>{c.name}</h1>
        </div>
        <span className={c.status === "active" ? "chip chip-ok" : "chip chip-bad"}>{c.status}</span>
      </div>

      <section className="panel">
        <dl className="kv">
          <div><dt>Type</dt><dd>{c.kind === "hauler" ? "Trucking company" : "Subcontractor"}</dd></div>
          <div><dt>Created</dt><dd>{formatDateTime(c.createdAt)}</dd></div>
          <div><dt>People</dt><dd>{c.users}</dd></div>
          <div><dt>Trucks</dt><dd>{c.trucks}</dd></div>
          {c.owners.map((o) => <div key={o.email}><dt>Owner</dt><dd>{o.name} ({o.email})</dd></div>)}
          {c.subscription ? (
            <>
              <div><dt>Plan</dt><dd>{c.subscription.plan} ({formatPeso(c.subscription.priceCentavos)} every {c.subscription.periodMonths} month{c.subscription.periodMonths > 1 ? "s" : ""})</dd></div>
              <div><dt>Subscription</dt><dd>{c.subscription.status}, until {formatDateTime(c.subscription.periodEnd)}</dd></div>
            </>
          ) : (
            <div><dt>Plan</dt><dd>None. This company is not limited.</dd></div>
          )}
        </dl>
        <p className="muted">The platform can see a company&apos;s name, plan and head counts only. Its clients, trips and rates stay private to the company.</p>
      </section>

      <CompanyActions id={c.id} status={c.status} planId={c.subscription?.planId ?? null} plans={plans.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }))} hasSubscription={!!c.subscription} />

      {c.payments.length > 0 && (
        <section className="panel stack" aria-label="Payments">
          <h2>Payments recorded</h2>
          <table className="table">
            <thead><tr><th>Date</th><th>Amount</th><th>Periods</th><th>Method</th><th>Reference</th></tr></thead>
            <tbody>
              {c.payments.map((p) => (
                <tr key={p.id}><td>{p.paidOn}</td><td>{formatPeso(p.amountCentavos)}</td><td>{p.periodsAdded}</td><td>{p.method ?? "-"}</td><td>{p.reference ?? "-"}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export default function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="panel">Loading…</div>}>
      <Body params={params} />
    </Suspense>
  );
}
