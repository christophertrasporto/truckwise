import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { getMySettlement } from "@/server/services/finance/settlements";
import { formatDateTime, formatPeso } from "@/shared/format";

export const metadata: Metadata = { title: "Settlement" };

/** A subcontractor's read-only copy of a settlement issued to its company. */
export default async function MySettlementPage({ params }: { params: Promise<{ haulerId: string; id: string }> }) {
  const { haulerId, id } = await params;
  const actor = await requireTenant();
  if (!can(actor, "settlement:read_own")) notFound();
  const s = await getMySettlement(actor, haulerId, id).catch(() => null);
  if (!s) notFound();
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
          <div><dt>Issued</dt><dd>{formatDateTime(s.issuedAt)}</dd></div>
          {s.paidAt && <div><dt>Paid</dt><dd>{formatDateTime(s.paidAt)}, ref {s.paymentReference}</dd></div>}
        </dl>
        <table className="table">
          <thead><tr><th>Trip</th><th>Payout</th></tr></thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.reference}>
                <td><b className="mono">{l.reference}</b><div className="muted">{l.description}</div></td>
                <td>{formatPeso(l.amountCentavos)}</td>
              </tr>
            ))}
            <tr><td><b>Total</b></td><td><b>{formatPeso(s.totalCentavos)}</b></td></tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
