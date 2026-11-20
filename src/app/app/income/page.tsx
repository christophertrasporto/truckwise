import type { Metadata } from "next";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { requireTenant } from "@/server/auth/current";
import { withTenant } from "@/server/db";
import { customers } from "@/server/db/schema";
import { can } from "@/server/policy";
import { costLedger } from "@/server/services/finance/costs";
import { incomeLedger } from "@/server/services/finance/income";
import { formatPeso } from "@/shared/format";
import { IncomeForm, VoidIncomeButton } from "./income-forms";

export const metadata: Metadata = { title: "Income" };

const thisMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7);
};

export default async function IncomePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireTenant();
  if (!can(actor, "income:read")) return <div className="empty">Your role does not include income.</div>;
  const sp = await searchParams;
  const month = sp.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : thisMonth();
  const [income, costs, clients] = await Promise.all([
    incomeLedger(actor, { month }),
    can(actor, "cost:read") ? costLedger(actor, { month }) : Promise.resolve(null),
    withTenant(actor.tenantId, actor.userId, (db) => db.select({ id: customers.id, name: customers.name }).from(customers).orderBy(asc(customers.name))),
  ]);
  const q = (m: string) => `?month=${m}`;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Income</h1>
          <p className="sub" style={{ margin: 0 }}>Money your clients paid you, by client. Costs are on the <Link href="/app/costs">Costs</Link> page.</p>
        </div>
        <div className="actions">
          <Link className="btn btn-ghost btn-sm" href={q(shiftMonth(month, -1))}>Previous month</Link>
          <Link className="btn btn-ghost btn-sm" href={q(thisMonth())}>This month</Link>
          <Link className="btn btn-ghost btn-sm" href={q(shiftMonth(month, 1))}>Next month</Link>
        </div>
      </div>

      <section className="panel stack" aria-label={`Income for ${month}`}>
        <h2>{month}: {formatPeso(income.totalCentavos)} received</h2>
        {costs && (
          <dl className="kv">
            <div><dt>Costs recorded</dt><dd>{formatPeso(costs.totalCentavos)}</dd></div>
            <div><dt>Received minus costs</dt><dd><b>{formatPeso(income.totalCentavos - costs.totalCentavos)}</b></dd></div>
          </dl>
        )}
        {income.byClient.length > 0 && (
          <dl className="kv">
            {income.byClient.map((c) => (
              <div key={c.clientId}><dt>{c.client}</dt><dd>{formatPeso(c.amountCentavos)}</dd></div>
            ))}
          </dl>
        )}
        <p className="muted">This is cash received, recorded by hand. It is separate from trip invoices and from the trip profit figures.</p>
      </section>

      {income.rows.length === 0 ? (
        <div className="empty">No income recorded for this month.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 640 }}>
            <thead><tr><th>Date</th><th>Client</th><th>Amount</th><th>Details</th><th /></tr></thead>
            <tbody>
              {income.rows.map((r) => (
                <tr key={r.id} style={r.voided ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                  <td>{r.receivedOn}</td>
                  <td>{r.client}</td>
                  <td><b>{formatPeso(r.amountCentavos)}</b></td>
                  <td>{r.note ?? ""}<div className="muted">{r.voided ? `Voided: ${r.voidReason}` : `by ${r.recordedBy}`}</div></td>
                  <td>{!r.voided && can(actor, "income:write") && <VoidIncomeButton id={r.id} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {can(actor, "income:write") && <IncomeForm clients={clients} />}
    </div>
  );
}
