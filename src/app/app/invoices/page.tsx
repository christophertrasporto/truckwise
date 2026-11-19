import type { Metadata } from "next";
import Link from "next/link";
import { ReadyGroup } from "@/components/finance-forms";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { invoiceableTrips, listInvoices } from "@/server/services/finance/invoices";
import { formatDateTime, formatPeso } from "@/shared/format";

export const metadata: Metadata = { title: "Invoices" };

const tone = { issued: "chip chip-warn", paid: "chip chip-ok", void: "chip" } as const;

export default async function InvoicesPage() {
  const actor = await requireTenant();
  if (!can(actor, "finance:read")) return <div className="empty">Your role does not include invoices.</div>;
  const [ready, list] = await Promise.all([invoiceableTrips(actor), listInvoices(actor)]);
  const manage = can(actor, "invoice:manage");
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Invoices</h1>
      </div>

      <section className="stack" aria-labelledby="ready">
        <h2 id="ready" style={{ fontSize: 16 }}>Ready to invoice ({ready.reduce((n, g) => n + g.trips.length, 0)} trips)</h2>
        {ready.length === 0 && <div className="empty">Nothing to bill. Trips appear here once their proof of delivery is approved.</div>}
        {manage ? (
          ready.map((g) => <ReadyGroup key={g.customerId} kind="invoice" partyId={g.customerId} partyName={g.customerName} trips={g.trips} />)
        ) : (
          ready.map((g) => (
            <div className="panel" key={g.customerId}>
              <b>{g.customerName}</b>: {g.trips.length} trip(s), {formatPeso(g.subtotalCentavos)}
            </div>
          ))
        )}
      </section>

      <section className="stack" aria-labelledby="issued">
        <h2 id="issued" style={{ fontSize: 16 }}>Invoices ({list.length})</h2>
        {list.length === 0 && <div className="empty">No invoices yet.</div>}
        {list.map((i) => (
          <Link key={i.id} href={`/app/invoices/${i.id}`} className="trip-card">
            <div className="row">
              <b className="mono">{i.number}</b>
              <span className={tone[i.status]}>{i.status}</span>
            </div>
            <div>{i.customerName}</div>
            <div className="row">
              <b>{formatPeso(i.totalCentavos)}</b>
              <span className="muted">Issued {formatDateTime(i.issuedAt)}{i.status === "issued" ? ` · due ${formatDateTime(i.dueAt)}` : ""}</span>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
