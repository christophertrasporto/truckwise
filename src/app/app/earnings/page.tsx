import type { Metadata } from "next";
import Link from "next/link";
import { StatusChip } from "@/components/trip-ui";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { driverEarnings } from "@/server/services/finance/earnings";
import { formatPeso } from "@/shared/format";
import type { TripStatus } from "@/shared/state-machines/trip";

export const metadata: Metadata = { title: "Earnings" };

export default async function EarningsPage() {
  const actor = await requireTenant();
  if (!can(actor, "earnings:read")) return <div className="empty">Earnings are shown to company drivers.</div>;
  const e = await driverEarnings(actor);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>My earnings</h1>
      </div>
      <section className="panel">
        <dl className="kv">
          <div><dt>Earned (delivery approved)</dt><dd><b>{formatPeso(e.earnedCentavos)}</b></dd></div>
          <div><dt>Coming (trips not finished yet)</dt><dd>{formatPeso(e.pendingCentavos)}</dd></div>
          <div><dt>Expenses to be paid back to you</dt><dd>{formatPeso(e.reimbursementsCentavos)}</dd></div>
        </dl>
      </section>
      {e.trips.length === 0 && <div className="empty">No trips yet.</div>}
      {e.trips.map((t) => (
        <Link key={t.tripId} href={`/app/trips/${t.tripId}`} className="trip-card">
          <div className="row">
            <b className="mono">{t.reference}</b>
            <StatusChip status={t.status as TripStatus} />
          </div>
          <div className="row">
            <span className="muted">{t.customerName}</span>
            <b>{formatPeso(t.payoutCentavos)}{t.earned ? "" : " (pending)"}</b>
          </div>
        </Link>
      ))}
    </div>
  );
}
