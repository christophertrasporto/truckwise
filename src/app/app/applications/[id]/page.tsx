import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { getApplication } from "@/server/services/applications";
import { formatDateTime } from "@/shared/format";
import { ReviewForm } from "./review-form";

export const metadata: Metadata = { title: "Application" };

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireTenant();
  if (actor.tenantKind !== "hauler" || !can(actor, "partner:read")) return <div className="empty">Your role does not include subcontractor applications.</div>;
  const a = await getApplication(actor, id);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{a.companyName}</h1>
          <p className="sub" style={{ margin: 0 }}>Applied {formatDateTime(a.createdAt)}</p>
        </div>
        <span className={a.status === "approved" ? "chip chip-ok" : a.status === "rejected" ? "chip chip-bad" : "chip chip-info"}>{a.status}</span>
      </div>
      <section className="panel">
        <dl className="kv">
          <div><dt>Contact</dt><dd>{a.contactName}</dd></div>
          <div><dt>Phone</dt><dd>{a.phone}</dd></div>
          <div><dt>Email</dt><dd>{a.email}</dd></div>
          {a.address && <div><dt>Address</dt><dd>{a.address}</dd></div>}
          <div><dt>Trucks</dt><dd>{a.trucks.length}</dd></div>
          {a.notes && <div><dt>Notes</dt><dd>{a.notes}</dd></div>}
        </dl>
      </section>
      {a.trucks.map((t, i) => (
        <section className="panel stack" key={t.plateNumber} aria-label={`Truck ${t.plateNumber}`}>
          <h2>{a.trucks.length > 1 ? `Truck ${i + 1}: ` : ""}{t.plateNumber}</h2>
          <dl className="kv">
            <div><dt>Truck</dt><dd>{t.truckType}, {t.truckSize}{t.capacityKg ? `, ${t.capacityKg} kg` : ""}</dd></div>
            <div><dt>Driver</dt><dd>{t.driverName}</dd></div>
            {t.licenseNumber && <div><dt>License no.</dt><dd>{t.licenseNumber}{t.licenseExpiry ? ` (expires ${t.licenseExpiry})` : ""}</dd></div>}
          </dl>
          <div className="grid-form two">
            {t.photos.map((p) => (
              <figure key={p.kind} style={{ margin: 0 }}>
                {p.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={`${t.plateNumber}: ${p.label}`} style={{ width: "100%", borderRadius: 8 }} /></a>
                ) : (
                  <div className="empty">Missing</div>
                )}
                <figcaption className="muted">{p.label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
      {a.status === "new" && can(actor, "partner:manage") ? (
        <ReviewForm id={a.id} />
      ) : (
        <p className="muted">
          {a.status === "new" ? "Only the owner or operations manager can approve." : `${a.status} ${formatDateTime(a.reviewedAt)} by ${a.reviewedBy ?? "-"}${a.reviewNote ? `: ${a.reviewNote}` : ""}.`}{" "}
          {a.partnerTenantId && <Link href="/app/partners">See subcontractors</Link>}
        </p>
      )}
    </div>
  );
}

export default function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="panel">Loading…</div>}>
      <Body params={params} />
    </Suspense>
  );
}
