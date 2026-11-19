import type { Metadata } from "next";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { requireTenant } from "@/server/auth/current";
import { withTenant } from "@/server/db";
import { trucks } from "@/server/db/schema";
import { can } from "@/server/policy";
import { costLedger } from "@/server/services/finance/costs";
import { COST_CATEGORIES } from "@/shared/costs";
import { formatPeso } from "@/shared/format";
import { CostForm, VoidCostButton } from "./cost-forms";

export const metadata: Metadata = { title: "Costs" };

const thisMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

export default async function CostsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireTenant();
  if (!can(actor, "cost:read")) return <div className="empty">Your role does not include company costs.</div>;
  const sp = await searchParams;
  const month = sp.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : thisMonth();
  const category = COST_CATEGORIES.some((c) => c.key === sp.category) ? sp.category : undefined;
  const ledger = await costLedger(actor, { month, category });
  const myTrucks = await withTenant(actor.tenantId, actor.userId, (db) => db.select({ id: trucks.id, plate: trucks.plate }).from(trucks).orderBy(asc(trucks.plate)));
  const q = (m: string, c?: string) => `?month=${m}${c ? `&category=${c}` : ""}`;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Costs</h1>
          <p className="sub" style={{ margin: 0 }}>Diesel, RFID, maintenance, salaries and everything else you spend. Each cost can be tied to a truck or a trip.</p>
        </div>
        <div className="actions">
          <Link className="btn btn-ghost btn-sm" href={q(shiftMonth(month, -1), category)}>Previous month</Link>
          <Link className="btn btn-ghost btn-sm" href={q(thisMonth(), category)}>This month</Link>
          <Link className="btn btn-ghost btn-sm" href={q(shiftMonth(month, 1), category)}>Next month</Link>
        </div>
      </div>

      <section className="panel stack" aria-label={`Costs for ${month}`}>
        <h2>{month}: {formatPeso(ledger.totalCentavos)}</h2>
        {ledger.salaryHidden && <p className="muted">Salaries are shown only to the owner and accountant.</p>}
        <div className="actions">
          <Link className={!category ? "chip chip-info" : "chip"} href={q(month)}>All</Link>
          {COST_CATEGORIES.map((c) => (
            <Link key={c.key} className={category === c.key ? "chip chip-info" : "chip"} href={q(month, c.key)}>{c.label}</Link>
          ))}
        </div>
        {ledger.byCategory.length > 0 && (
          <dl className="kv">
            {ledger.byCategory.map((c) => (
              <div key={c.category}><dt>{c.label}</dt><dd>{formatPeso(c.amountCentavos)}</dd></div>
            ))}
          </dl>
        )}
        {ledger.byTruck.length > 0 && (
          <p className="muted">By truck: {ledger.byTruck.map((t) => `${t.plate} ${formatPeso(t.amountCentavos)}`).join(" · ")}</p>
        )}
      </section>

      {ledger.rows.length === 0 ? (
        <div className="empty">No costs recorded for this month.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 720 }}>
            <thead>
              <tr><th>Date</th><th>Type</th><th>Amount</th><th>Details</th><th /></tr>
            </thead>
            <tbody>
              {ledger.rows.map((r) => (
                <tr key={r.id} style={r.voided ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                  <td>{r.incurredOn}</td>
                  <td>{r.label}</td>
                  <td><b>{formatPeso(r.amountCentavos)}</b></td>
                  <td>
                    {r.payee ?? ""}{r.note ? ` · ${r.note}` : ""}
                    <div className="muted">
                      {r.truckPlate ? `Truck ${r.truckPlate} · ` : ""}
                      {r.tripId ? <Link href={`/app/trips/${r.tripId}`}>{r.tripReference}</Link> : null}
                      {r.voided ? ` Voided: ${r.voidReason}` : ` by ${r.recordedBy}`}
                    </div>
                  </td>
                  <td>{!r.voided && can(actor, "cost:write") && <VoidCostButton id={r.id} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {can(actor, "cost:write") && <CostForm trucks={myTrucks} canSalary={actor.role === "owner" || actor.role === "accountant"} />}
    </div>
  );
}
