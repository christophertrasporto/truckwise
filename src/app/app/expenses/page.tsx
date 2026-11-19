import type { Metadata } from "next";
import Link from "next/link";
import { ExpenseReviewRow } from "@/components/finance-forms";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { listExpensesToReview } from "@/server/services/finance/expenses";
import { formatDateTime, formatPeso } from "@/shared/format";

export const metadata: Metadata = { title: "Expenses to review" };

export default async function ExpensesPage() {
  const actor = await requireTenant();
  if (!can(actor, "expense:review")) return <div className="empty">Your role does not review expenses.</div>;
  const rows = await listExpensesToReview(actor);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Expenses to review</h1>
          <p className="sub" style={{ margin: 0 }}>Costs drivers reported with a receipt. An approved expense reduces trip profit only when the company pays it.</p>
        </div>
      </div>
      {rows.length === 0 && <div className="empty">Nothing waiting for review.</div>}
      {rows.map((e) => (
        <section className="panel stack" key={e.id} aria-label={`Expense ${e.category} ${e.tripReference}`}>
          <div className="row" style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <div>
              <Link href={`/app/trips/${e.tripId}`}><b className="mono">{e.tripReference}</b></Link> <span className="muted">{e.customerName}</span>
            </div>
            <b>{formatPeso(e.amountCentavos)}</b>
          </div>
          <div>
            <span className="chip">{e.category}</span> by {e.submittedByName} · {formatDateTime(e.incurredAt)}
            {e.note && <div className="muted">{e.note}</div>}
          </div>
          {e.receiptUrl && (
            <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="photos" style={{ maxWidth: 180 }} title="Open the receipt">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={e.receiptUrl} alt={`Receipt for ${e.category}`} loading="lazy" />
            </a>
          )}
          <ExpenseReviewRow id={e.id} />
        </section>
      ))}
    </div>
  );
}
