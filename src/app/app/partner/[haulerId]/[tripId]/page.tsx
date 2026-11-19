import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusChip } from "@/components/trip-ui";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { getTripForPartner } from "@/server/services/partner";
import { formatDateTime, formatPeso } from "@/shared/format";
import { PartnerAccept } from "./partner-accept";

export const metadata: Metadata = { title: "Trip" };

export default async function PartnerTripPage({ params }: { params: Promise<{ haulerId: string; tripId: string }> }) {
  const { haulerId, tripId } = await params;
  const actor = await requireTenant();
  if (!can(actor, "partner:accept")) notFound();
  const d = await getTripForPartner(actor, haulerId, tripId).catch(() => null);
  if (!d) notFound();
  const t = d.trip;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <Link href="/app" className="muted">&larr; Trips for our company</Link>
          <h1 className="mono">{t.reference}</h1>
        </div>
        <StatusChip status={t.status} />
      </div>

      {d.assignment && (
        <div className="notice ok-note">
          Assigned to {d.assignment.driverName ?? "your driver"} with truck {d.assignment.truckPlate ?? "-"}.
        </div>
      )}
      {d.requested && <div className="notice">Your request was sent. The trucking company will confirm it.</div>}
      {d.offered && !d.requested && <PartnerAccept haulerId={haulerId} tripId={tripId} />}

      <section className="panel">
        <h2>Trip</h2>
        <dl className="kv">
          <div><dt>Client</dt><dd>{t.customerName}</dd></div>
          <div><dt>Payout to your company</dt><dd>{formatPeso(t.payoutCentavos)}</dd></div>
          <div><dt>Cargo</dt><dd>{t.cargoDescription}</dd></div>
          <div><dt>Truck needed</dt><dd>{t.truckRequirement ?? "Any"}</dd></div>
          <div><dt>Weight / quantity</dt><dd>{t.weightKg ?? "-"} kg / {t.quantity ?? "-"}</dd></div>
          <div><dt>Included in payout</dt><dd>{[t.fuelIncluded && "Fuel", t.tollIncluded && "Tolls"].filter(Boolean).join(", ") || "Neither fuel nor tolls"}</dd></div>
          <div style={{ gridColumn: "1 / -1" }}><dt>Handling</dt><dd>{t.handlingInstructions ?? "-"}</dd></div>
        </dl>
      </section>
      <section className="panel">
        <h2>Route</h2>
        <ol className="stops">
          {d.stops.map((s) => (
            <li key={s.seq}>
              <span className={`n ${s.kind}`}>{s.seq}</span>
              <div>
                <b>{s.kind === "pickup" ? "Pickup" : "Delivery"}</b>
                <div>{s.address}</div>
                <div className="muted">Required by {formatDateTime(s.requiredArrivalAt)}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
