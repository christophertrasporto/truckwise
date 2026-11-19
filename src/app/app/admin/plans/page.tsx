import type { Metadata } from "next";
import Link from "next/link";
import { requireSignedIn } from "@/server/auth/current";
import { listPlans } from "@/server/services/admin";
import { formatPeso } from "@/shared/format";
import { PlanForm } from "../admin-forms";

export const metadata: Metadata = { title: "Plans" };

export default async function PlansPage() {
  const actor = await requireSignedIn();
  if (!actor.isPlatformAdmin) return <div className="empty">This area is for the platform administrator.</div>;
  const plans = await listPlans(actor);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="muted" style={{ margin: 0 }}><Link href="/app/admin">← Platform</Link></p>
          <h1>Plans</h1>
        </div>
      </div>
      {plans.length === 0 && <div className="empty">No plans yet. Create the first one below.</div>}
      {plans.map((p) => (
        <details key={p.id} className="panel">
          <summary>
            <b>{p.name}</b> · {formatPeso(p.priceCentavos)} every {p.periodMonths} month{p.periodMonths > 1 ? "s" : ""} · {p.companies} compan{p.companies === 1 ? "y" : "ies"}
            {!p.active && <span className="chip chip-bad" style={{ marginLeft: 8 }}>closed to new companies</span>}
          </summary>
          <div style={{ marginTop: 12 }}>
            <PlanForm plan={{ id: p.id, name: p.name, description: p.description, priceCentavos: p.priceCentavos, periodMonths: p.periodMonths, maxTrucks: p.maxTrucks, maxDrivers: p.maxDrivers, maxUsers: p.maxUsers, features: p.features, active: p.active }} />
          </div>
        </details>
      ))}
      <PlanForm />
    </div>
  );
}
