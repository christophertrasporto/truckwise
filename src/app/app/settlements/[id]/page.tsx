import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PayForm, VoidForm } from "@/components/finance-forms";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { getSettlement } from "@/server/services/finance/settlements";
import { formatDateTime, formatPeso } from "@/shared/format";

export const metadata: Metadata = { title: "Settlement" };

export default async function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireTenant();
  if (!can(actor, "finance:read")) notFound();
  const s = await getSettlement(actor, id).catch(() => null);
  if (!s) notFound();
  const manage = can(actor, "settlement:manage");
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <Link href="/app/settlements" className="muted">&larr; Settlements</Link>
          <h1 className="mono">{s.number}</h1>
        </div>
        <span className={s.status === "paid" ? "chip chip-ok" : s.status === "void" ? "chip" : "chip chip-warn"}>{s.status}</span>
      </div>
      <section className="panel stack">
        <dl className="kv">
          <div><dt>Subcontractor</dt><dd>{s.partnerName}</dd></div>
          <div><dt>Issued</dt><dd>{formatDateTime(s.issuedAt)}</dd></div>
          {s.paidAt && <div><dt>Paid</dt><dd>{formatDateTime(s.paidAt)}, ref {s.paymentReference}</dd></div>}
          {s.voidedAt && <div><dt>Voided</dt><dd>{formatDateTime(s.voidedAt)}: {s.voidReason}</dd></div>}
        </dl>
        <table className="table">
          <thead><tr><th>Trip</th><th>Amount (agreed payout)</th></tr></thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.id}>
                <td><Link href={`/app/trips/${l.tripId}`}><b className="mono">{l.reference}</b></Link><div className="muted">{l.description}</div></td>
                <td>{formatPeso(l.amountCentavos)}</td>
              </tr>
            ))}
            <tr><td><b>Total</b></td><td><b>{formatPeso(s.totalCentavos)}</b></td></tr>
          </tbody>
        </table>
      </section>
      {manage && s.status === "issued" && (
        <>
          <PayForm kind="settlement" id={s.id} />
          <VoidForm kind="settlement" id={s.id} />
        </>
      )}
    </div>
  );
}
