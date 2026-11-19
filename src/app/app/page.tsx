import type { Metadata } from "next";
import Link from "next/link";
import { BoardCard, FilterForm, type BoardItem } from "@/components/board";
import { TripCard } from "@/components/trip-ui";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { boardQuery } from "@/server/query";
import { listDriverBoard, listMyTrips } from "@/server/services/offers";
import { listPartnerBoard, listPartnerWork } from "@/server/services/partner";
import { listTripsForStaff } from "@/server/services/trips";
import { formatPeso } from "@/shared/format";

export const metadata: Metadata = { title: "Trips" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Home({ searchParams }: { searchParams: SP }) {
  const actor = await requireTenant();
  const sp = await searchParams;
  const filters = boardQuery(sp);

  // Internal drivers: the available-trips board, direct offers kept apart from company broadcasts.
  if (actor.role === "driver") {
    const [{ direct, broadcast }, mine] = await Promise.all([listDriverBoard(actor, filters), listMyTrips(actor)]);
    const card = (t: (typeof direct)[number]) => <BoardCard key={t.id} item={t as BoardItem} href={`/app/trips/${t.id}`} />;
    return (
      <div className="stack">
        <div className="page-head">
          <h1>My trips</h1>
        </div>
        <FilterForm values={filters} />
        <section className="stack" aria-labelledby="direct">
          <h2 id="direct" style={{ fontSize: 16 }}>Offered to you ({direct.length})</h2>
          {direct.length === 0 && <div className="empty">No trips are offered to you personally.</div>}
          {direct.map(card)}
        </section>
        <section className="stack" aria-labelledby="open">
          <h2 id="open" style={{ fontSize: 16 }}>Open to the company ({broadcast.length})</h2>
          {broadcast.length === 0 && <div className="empty">No open trips match.</div>}
          {broadcast.map(card)}
        </section>
        <section className="stack" aria-labelledby="mine">
          <h2 id="mine" style={{ fontSize: 16 }}>Accepted ({mine.length})</h2>
          {mine.length === 0 && <div className="empty">You have no accepted trips.</div>}
          {mine.map((t) => (
            <TripCard key={t.id} id={t.id} reference={t.reference} status={t.status} customerName={t.customerName} cargo={t.cargoDescription} right={"payoutCentavos" in t ? <b>{formatPeso(t.payoutCentavos)}</b> : undefined} />
          ))}
        </section>
      </div>
    );
  }

  // A subcontractor's own driver: only trips assigned to them, and no money.
  if (actor.role === "sub_driver") {
    const mine = await listMyTrips(actor);
    return (
      <div className="stack">
        <div className="page-head">
          <h1>My trips</h1>
        </div>
        {mine.length === 0 && <div className="empty">You have no trips assigned right now.</div>}
        {mine.map((t) => (
          <TripCard key={t.id} id={t.id} reference={t.reference} status={t.status} customerName={t.customerName} cargo={t.cargoDescription} right={t.truckPlate ? <span className="muted">{t.truckPlate}</span> : undefined} />
        ))}
      </div>
    );
  }

  // Subcontractor company: offers from the haulers that approved us, and our jobs.
  if (can(actor, "partner:accept")) {
    const [{ direct, broadcast }, work] = await Promise.all([listPartnerBoard(actor, filters), listPartnerWork(actor)]);
    const card = (t: (typeof direct)[number]) => <BoardCard key={t.id} item={t as BoardItem} href={`/app/partner/${t.haulerTenantId}/${t.id}`} />;
    return (
      <div className="stack">
        <div className="page-head">
          <h1>Trips for our company</h1>
        </div>
        <FilterForm values={filters} />
        <section className="stack" aria-labelledby="direct">
          <h2 id="direct" style={{ fontSize: 16 }}>Offered to our company ({direct.length})</h2>
          {direct.length === 0 && <div className="empty">Nothing offered directly to you.</div>}
          {direct.map(card)}
        </section>
        <section className="stack" aria-labelledby="open">
          <h2 id="open" style={{ fontSize: 16 }}>Open to subcontractors ({broadcast.length})</h2>
          {broadcast.length === 0 && <div className="empty">No open trips match.</div>}
          {broadcast.map(card)}
        </section>
        <section className="stack" aria-labelledby="jobs">
          <h2 id="jobs" style={{ fontSize: 16 }}>Our jobs ({work.assigned.length}) and requests ({work.pending.length})</h2>
          {work.assigned.length + work.pending.length === 0 && <div className="empty">No jobs yet.</div>}
          {[...work.pending.map((t) => ({ t, pending: true })), ...work.assigned.map((t) => ({ t, pending: false }))].map(({ t, pending }) => (
            <Link key={t.id} href={`/app/partner/${t.haulerTenantId}/${t.id}`} className="trip-card">
              <div className="row">
                <b className="mono">{t.reference}</b>
                <span className={pending ? "chip chip-warn" : "chip chip-info"}>{pending ? "Waiting for approval" : t.status.replace(/_/g, " ")}</span>
              </div>
              <div className="muted">From {t.haulerName} · {t.driverName ?? "-"} · {t.truckPlate ?? "-"}</div>
              <b>{formatPeso(t.payoutCentavos)}</b>
            </Link>
          ))}
        </section>
      </div>
    );
  }

  if (!can(actor, "trip:read")) return <div className="empty">Your role does not include trips yet.</div>;
  const trips = await listTripsForStaff(actor);
  const show = can(actor, "trip:view_rate");
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Trips</h1>
          <p className="sub" style={{ margin: 0 }}>{trips.length} total</p>
        </div>
        <div className="actions">
          <Link href="/app/calendar" className="btn btn-ghost">Calendar</Link>
          {can(actor, "trip:create") && (
            <Link href="/app/trips/new" className="btn btn-primary">
              New trip
            </Link>
          )}
        </div>
      </div>
      {trips.length === 0 && <div className="empty">No trips yet. Create the first one.</div>}
      {trips.map((t) => (
        <TripCard key={t.id} id={t.id} reference={t.reference} status={t.status} customerName={t.customerName} cargo={t.cargoDescription} right={show ? <span className="muted">Rate {formatPeso(t.contractRateCentavos)} / Payout {formatPeso(t.payoutCentavos)}</span> : undefined} />
      ))}
    </div>
  );
}
