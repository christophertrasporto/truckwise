import type { Metadata } from "next";
import Link from "next/link";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { companyPnl } from "@/server/services/finance/costs";
import { profitSummary } from "@/server/services/finance/profit";
import { formatPeso } from "@/shared/format";

export const metadata: Metadata = { title: "Trip profit" };

const thisMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const pct =(bps: number | null) => (bps === null ? "-" : `${(bps / 100).toFixed(1)}%`);

export default async function ProfitPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireTenant();
  if (!can(actor, "finance:read")) return <div className="empty">Your role does not include profit figures.</div>;
  const sp = await searchParams;
  const all = sp.all === "1";
  const { items, totals } = await profitSummary(actor, { onlyCompleted: !all });
  const month = sp.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : thisMonth();
  // A plan without the profit-and-loss feature simply does not show the section.
  const pnl = can(actor, "pnl:read") ? await companyPnl(actor, month).catch((e: { status?: number }) => (e?.status === 402 ? null : Promise.reject(e))) : null;
  const shift = (by: number) => {
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
  };
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Trip profit</h1>
          <p className="sub" style={{ margin: 0 }}>Customer charge minus partner payout or driver pay, minus approved company-paid expenses. Before overhead and taxes.</p>
        </div>
        <div className="actions">
          <Link href="?" className={all ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}>Finished trips</Link>
          <Link href="?all=1" className={all ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}>All open trips too</Link>
        </div>
      </div>

      {pnl && (
        <section className="panel stack" aria-label={`Company profit for ${month}`}>
          <div className="page-head" style={{ margin: 0 }}>
            <h2>Company profit, {month}</h2>
            <div className="actions">
              <Link className="btn btn-ghost btn-sm" href={`?month=${shift(-1)}`}>Previous month</Link>
              <Link className="btn btn-ghost btn-sm" href={`?month=${shift(1)}`}>Next month</Link>
            </div>
          </div>
          <dl className="kv">
            <div><dt>Trips finished</dt><dd>{pnl.tripCount}</dd></div>
            <div><dt>Revenue (customer rates)</dt><dd>{formatPeso(pnl.revenueCentavos)}</dd></div>
            <div><dt>Subcontractor trips: you charged / you paid</dt><dd>{formatPeso(pnl.subcontractor.revenueCentavos)} / {formatPeso(pnl.subcontractor.payoutCentavos)}</dd></div>
            <div><dt>Left from subcontractor trips ({pnl.subcontractor.trips})</dt><dd><b>{formatPeso(pnl.subcontractor.profitCentavos)}</b></dd></div>
            <div><dt>Own-truck trips: you charged / driver and helper pay</dt><dd>{formatPeso(pnl.ownTrucks.revenueCentavos)} / {formatPeso(pnl.ownTrucks.driverPayCentavos + pnl.ownTrucks.helperPayCentavos)}</dd></div>
            <div><dt>Left from own-truck trips ({pnl.ownTrucks.trips})</dt><dd><b>{formatPeso(pnl.ownTrucks.profitCentavos)}</b></dd></div>
            <div><dt>Profit from trips</dt><dd>{formatPeso(pnl.tripProfitCentavos)}</dd></div>
            <div><dt>Other costs (salary, maintenance...)</dt><dd>{formatPeso(pnl.overheadCentavos)}</dd></div>
            <div><dt>Net profit</dt><dd><b style={{ color: pnl.netProfitCentavos < 0 ? "var(--bad)" : undefined }}>{formatPeso(pnl.netProfitCentavos)}</b>{pnl.netMarginBps !== null ? ` (${(pnl.netMarginBps / 100).toFixed(1)}%)` : ""}</dd></div>
          </dl>
          {pnl.overheadByCategory.length > 0 && <p className="muted">Other costs: {pnl.overheadByCategory.map((c) => `${c.label} ${formatPeso(c.amountCentavos)}`).join(" · ")}. <Link href={`/app/costs?month=${month}`}>Open the cost ledger</Link></p>}
        </section>
      )}

      <section className="panel">
        <dl className="kv">
          <div><dt>Revenue</dt><dd>{formatPeso(totals.revenueCentavos)}</dd></div>
          <div><dt>Subcontractor payouts</dt><dd>{formatPeso(totals.partnerPayoutCentavos)}</dd></div>
          <div><dt>Driver pay</dt><dd>{formatPeso(totals.driverPayCentavos)}</dd></div>
          <div><dt>Helper pay</dt><dd>{formatPeso(totals.helperPayCentavos)}</dd></div>
          <div><dt>Company-paid expenses</dt><dd>{formatPeso(totals.directExpensesCentavos)}</dd></div>
          <div><dt>Profit</dt><dd><b>{formatPeso(totals.profitCentavos)}</b> ({pct(totals.marginBps)})</dd></div>
        </dl>
      </section>

      {items.length === 0 ? (
        <div className="empty">No trips to show yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>Trip</th>
                <th>Done by</th>
                <th>Revenue</th>
                <th>Partner payout</th>
                <th>Driver pay</th>
                <th>Expenses</th>
                <th>Profit</th>
                <th>Billing</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.tripId}>
                  <td>
                    <Link href={`/app/trips/${t.tripId}`}><b className="mono">{t.reference}</b></Link>
                    <div className="muted">{t.customerName}</div>
                  </td>
                  <td>{t.assigneeName ? (t.assignedTo === "partner" ? t.assigneeName : t.driverName ?? "Our driver") : "Not assigned"}</td>
                  <td>{formatPeso(t.profit.revenueCentavos)}</td>
                  <td>{t.profit.partnerPayoutCentavos ? formatPeso(t.profit.partnerPayoutCentavos) : "-"}</td>
                  <td>{t.profit.driverPayCentavos ? formatPeso(t.profit.driverPayCentavos) : "-"}{t.profit.helperPayCentavos ? ` + helper ${formatPeso(t.profit.helperPayCentavos)}` : ""}</td>
                  <td>
                    {t.profit.directExpensesCentavos ? formatPeso(t.profit.directExpensesCentavos) : "-"}
                    {t.profit.pendingExpensesCentavos > 0 && <div className="muted">+{formatPeso(t.profit.pendingExpensesCentavos)} pending</div>}
                  </td>
                  <td>
                    <b style={{ color: t.profit.profitCentavos < 0 ? "var(--bad)" : undefined }}>{formatPeso(t.profit.profitCentavos)}</b>
                    <div className="muted">{pct(t.profit.marginBps)}{t.profit.costsKnown ? "" : " (cost not final)"}</div>
                  </td>
                  <td>
                    {t.invoice ? <Link href={`/app/invoices/${t.invoice.id}`} className="mono">{t.invoice.number}</Link> : <span className="muted">Not invoiced</span>}
                    {t.settlement && (
                      <div>
                        <Link href={`/app/settlements/${t.settlement.id}`} className="mono">{t.settlement.number}</Link>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
