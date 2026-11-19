import type { Metadata } from "next";
import Link from "next/link";
import { ReadyGroup } from "@/components/finance-forms";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { listMySettlements, listSettlements, settleableTrips } from "@/server/services/finance/settlements";
import { formatDateTime, formatPeso } from "@/shared/format";

export const metadata: Metadata = { title: "Settlements" };

const tone = { issued: "chip chip-warn", paid: "chip chip-ok", void: "chip" } as const;

export default async function SettlementsPage() {
  const actor = await requireTenant();

  // A subcontractor company: only what the trucking companies have issued to it.
  if (can(actor, "settlement:read_own")) {
    const mine = await listMySettlements(actor);
    return (
      <div className="stack">
        <div className="page-head">
          <h1>Settlements</h1>
        </div>
        {mine.length === 0 && <div className="empty">No settlements yet. They appear here once a trucking company settles your finished trips.</div>}
        {mine.map((s) => (
          <Link key={s.id} href={`/app/settlements/from/${s.haulerTenantId}/${s.id}`} className="trip-card">
            <div className="row">
              <b className="mono">{s.number}</b>
              <span className={tone[s.status]}>{s.status}</span>
            </div>
            <div>From {s.haulerName}</div>
            <div className="row">
              <b>{formatPeso(s.totalCentavos)}</b>
              <span className="muted">Issued {formatDateTime(s.issuedAt)}{s.paidAt ? ` · paid ${formatDateTime(s.paidAt)}` : ""}</span>
            </div>
          </Link>
        ))}
      </div>
    );
  }

  if (!can(actor, "finance:read")) return <div className="empty">Your role does not include settlements.</div>;
  const [ready, list] = await Promise.all([settleableTrips(actor), listSettlements(actor)]);
  const manage = can(actor, "settlement:manage");
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Settlements</h1>
      </div>
      <section className="stack" aria-labelledby="ready">
        <h2 id="ready" style={{ fontSize: 16 }}>Ready to settle ({ready.reduce((n, g) => n + g.trips.length, 0)} trips)</h2>
        {ready.length === 0 && <div className="empty">Nothing to settle. Trips done by subcontractors appear here once their proof is approved.</div>}
        {manage
          ? ready.map((g) => <ReadyGroup key={g.partnerTenantId} kind="settlement" partyId={g.partnerTenantId} partyName={g.partnerName} trips={g.trips} />)
          : ready.map((g) => (
              <div className="panel" key={g.partnerTenantId}>
                <b>{g.partnerName}</b>: {g.trips.length} trip(s), {formatPeso(g.totalCentavos)}
              </div>
            ))}
      </section>
      <section className="stack" aria-labelledby="issued">
        <h2 id="issued" style={{ fontSize: 16 }}>Settlements ({list.length})</h2>
        {list.length === 0 && <div className="empty">No settlements yet.</div>}
        {list.map((s) => (
          <Link key={s.id} href={`/app/settlements/${s.id}`} className="trip-card">
            <div className="row">
              <b className="mono">{s.number}</b>
              <span className={tone[s.status]}>{s.status}</span>
            </div>
            <div>{s.partnerName}</div>
            <div className="row">
              <b>{formatPeso(s.totalCentavos)}</b>
              <span className="muted">Issued {formatDateTime(s.issuedAt)}</span>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
