import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PayForm, VoidForm } from "@/components/finance-forms";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { getInvoice } from "@/server/services/finance/invoices";
import { formatDateTime, formatPeso } from "@/shared/format";

export const metadata: Metadata = { title: "Invoice" };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireTenant();
  if (!can(actor, "finance:read")) notFound();
  const inv = await getInvoice(actor, id).catch(() => null);
  if (!inv) notFound();
  const manage = can(actor, "invoice:manage");
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <Link href="/app/invoices" className="muted">&larr; Invoices</Link>
          <h1 className="mono">{inv.number}</h1>
        </div>
        <div className="actions">
          <span className={inv.status === "paid" ? "chip chip-ok" : inv.status === "void" ? "chip" : "chip chip-warn"}>{inv.status}</span>
          <a className="btn btn-primary btn-sm" href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">Download PDF with proof</a>
        </div>
      </div>

      <section className="panel">
        <dl className="kv">
          <div><dt>Bill to</dt><dd>{inv.customerName}{inv.customerAddress ? `, ${inv.customerAddress}` : ""}</dd></div>
          <div><dt>Issued</dt><dd>{formatDateTime(inv.issuedAt)}</dd></div>
          <div><dt>Payment due</dt><dd>{formatDateTime(inv.dueAt)} ({inv.paymentTermsDays} days)</dd></div>
          {inv.paidAt && <div><dt>Paid</dt><dd>{formatDateTime(inv.paidAt)}, ref {inv.paymentReference}</dd></div>}
          {inv.voidedAt && <div><dt>Voided</dt><dd>{formatDateTime(inv.voidedAt)}: {inv.voidReason}</dd></div>}
          {inv.notes && <div style={{ gridColumn: "1 / -1" }}><dt>Notes</dt><dd>{inv.notes}</dd></div>}
        </dl>
      </section>

      <section className="panel stack">
        <h2>Billed trips</h2>
        {inv.lines.map((l) => (
          <div key={l.id} className="proof">
            <div className="row" style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <Link href={`/app/trips/${l.tripId}`}><b className="mono">{l.reference}</b></Link>
              <b>{formatPeso(l.amountCentavos)}</b>
            </div>
            <div className="muted">{l.description}</div>
            <div aria-label={`Approved proof of delivery for ${l.reference}`}>
              {l.proof.length === 0 && <p className="muted">No approved proof on file.</p>}
              {l.proof.map((p, i) => (
                <div key={i} className="stack" style={{ gap: 8, marginTop: 10 }}>
                  <div>
                    <b>{p.stopSeq ? `Stop ${p.stopSeq}` : "Delivery"}{p.stopAddress ? `, ${p.stopAddress}` : ""}</b>
                    <div className="muted">
                      Received by {p.receiverName}. Delivered (driver-confirmed) {formatDateTime(p.deliveredAt)}. Received by system {formatDateTime(p.uploadedAt)}. Approved {formatDateTime(p.approvedAt)} by {p.approvedBy}.
                    </div>
                  </div>
                  <div className="photos">
                    {p.photos.map((ph) => (
                      <a key={ph.id} href={ph.url} target="_blank" rel="noreferrer" title={`${ph.filename} (original)`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={ph.displayUrl ?? ph.url} alt={`Proof photo ${ph.filename}`} loading="lazy" />
                      </a>
                    ))}
                  </div>
                  {p.signature && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.signature.url} alt="Receiver signature" style={{ maxWidth: 280, width: "100%", background: "#fff", border: "1px solid var(--line)", borderRadius: 10 }} />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        <dl className="kv" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div><dt>Subtotal</dt><dd>{formatPeso(inv.subtotalCentavos)}</dd></div>
          <div><dt>VAT ({(inv.vatBps / 100).toFixed(inv.vatBps % 100 ? 2 : 0)}%)</dt><dd>{formatPeso(inv.vatCentavos)}</dd></div>
          <div><dt>Total</dt><dd><b>{formatPeso(inv.totalCentavos)}</b></dd></div>
        </dl>
      </section>

      {manage && inv.status === "issued" && (
        <>
          <PayForm kind="invoice" id={inv.id} />
          <VoidForm kind="invoice" id={inv.id} />
        </>
      )}
    </div>
  );
}
