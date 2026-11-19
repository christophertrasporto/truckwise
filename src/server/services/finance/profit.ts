import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { computeProfit, type Profit } from "@/shared/finance";
import { withTenant, type Db } from "../../db";
import { companyExpenses, customers, invoiceLines, invoices, settlementLines, settlements, tenants, tripAssignments, tripExpenses, trips } from "../../db/schema";
import { HttpError } from "../../errors";
import { authorize } from "../../policy";
import type { TenantActor } from "../trips";
import { listTripExpenses } from "./expenses";

export interface TripFinancials {
  tripId: string;
  reference: string;
  status: string;
  customerName: string;
  assignedTo: "internal" | "partner" | null;
  assigneeName: string | null;
  driverName: string | null;
  profit: Profit;
  invoice: { id: string; number: string; status: string } | null;
  settlement: { id: string; number: string; status: string } | null;
}

/** Facts for many trips in a handful of queries (the caller's context decides which trips are visible). */
async function financialsFor(db: Db, hauler: string, tripRows: { trip: typeof trips.$inferSelect; customerName: string }[]): Promise<TripFinancials[]> {
  const ids = tripRows.map((r) => r.trip.id);
  if (ids.length === 0) return [];
  const [assigns, expenses, ledger, invs, sets] = await Promise.all([
    db
      .select({ a: tripAssignments, company: tenants.name })
      .from(tripAssignments)
      .innerJoin(tenants, eq(tenants.id, tripAssignments.assignedTenantId))
      .where(and(inArray(tripAssignments.tripId, ids), eq(tripAssignments.status, "active"))),
    db.select().from(tripExpenses).where(inArray(tripExpenses.tripId, ids)),
    db.select().from(companyExpenses).where(and(inArray(companyExpenses.tripId, ids), isNull(companyExpenses.voidedAt))),
    db
      .select({ tripId: invoiceLines.tripId, id: invoices.id, number: invoices.number, status: invoices.status })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(and(inArray(invoiceLines.tripId, ids), eq(invoiceLines.active, true))),
    db
      .select({ tripId: settlementLines.tripId, id: settlements.id, number: settlements.number, status: settlements.status })
      .from(settlementLines)
      .innerJoin(settlements, eq(settlements.id, settlementLines.settlementId))
      .where(and(inArray(settlementLines.tripId, ids), eq(settlementLines.active, true))),
  ]);
  return tripRows.map(({ trip, customerName }) => {
    const a = assigns.find((x) => x.a.tripId === trip.id);
    const assignedTo = a ? (a.a.assignedTenantId === hauler ? "internal" : "partner") : null;
    const inv = invs.find((x) => x.tripId === trip.id);
    const set = sets.find((x) => x.tripId === trip.id);
    return {
      tripId: trip.id,
      reference: trip.reference,
      status: trip.status,
      customerName,
      assignedTo,
      assigneeName: a ? a.company : null,
      driverName: a?.a.driverName ?? null,
      profit: computeProfit({
        revenueCentavos: trip.contractRateCentavos,
        payoutCentavos: assignedTo === "partner" ? (trip.subcontractorPayoutCentavos ?? trip.payoutCentavos) : trip.payoutCentavos,
        helperPayCentavos: trip.helperPayCentavos,
        assignedTo,
        expenses: [
          ...expenses.filter((e) => e.tripId === trip.id).map((e) => ({ status: e.status, companyBears: e.companyBears, amountCentavos: e.amountCentavos })),
          // the owner's own ledger entries for this trip are approved, company-paid costs
          ...ledger.filter((e) => e.tripId === trip.id).map((e) => ({ status: "approved" as const, companyBears: true, amountCentavos: e.amountCentavos })),
        ],
      }),
      invoice: inv ? { id: inv.id, number: inv.number, status: inv.status } : null,
      settlement: set ? { id: set.id, number: set.number, status: set.status } : null,
    };
  });
}

/** Full money picture of one trip. Finance roles only: it contains the customer rate and the margin. */
export async function tripFinancials(actor: TenantActor, tripId: string) {
  authorize(actor, "finance:read");
  const financials = await withTenant(actor.tenantId, actor.userId, async (db) => {
    const [row] = await db
      .select({ trip: trips, customerName: customers.name })
      .from(trips)
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .where(eq(trips.id, tripId));
    if (!row) throw new HttpError(404, "Trip not found");
    return (await financialsFor(db, actor.tenantId, [row]))[0];
  });
  return { ...financials, expenses: await listTripExpenses(actor, tripId) };
}

/**
 * Profit per trip with totals. By default only finished trips (ready for invoice), since the others still
 * have open costs. Pass `onlyCompleted: false` for every non-cancelled trip.
 */
export async function profitSummary(actor: TenantActor, opts: { onlyCompleted?: boolean } = {}) {
  authorize(actor, "finance:read");
  const onlyCompleted = opts.onlyCompleted ?? true;
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ trip: trips, customerName: customers.name })
      .from(trips)
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .orderBy(desc(trips.createdAt));
    const wanted = rows.filter((r) => (onlyCompleted ? r.trip.status === "ready_for_invoice" : r.trip.status !== "cancelled"));
    const items = await financialsFor(db, actor.tenantId, wanted);
    const sum = (f: (p: Profit) => number) => items.reduce((n, i) => n + f(i.profit), 0);
    const revenue = sum((p) => p.revenueCentavos);
    const profit = sum((p) => p.profitCentavos);
    return {
      items,
      totals: {
        revenueCentavos: revenue,
        partnerPayoutCentavos: sum((p) => p.partnerPayoutCentavos),
        driverPayCentavos: sum((p) => p.driverPayCentavos),
        helperPayCentavos: sum((p) => p.helperPayCentavos),
        directExpensesCentavos: sum((p) => p.directExpensesCentavos),
        profitCentavos: profit,
        marginBps: revenue > 0 ? Math.round((profit * 10_000) / revenue) : null,
      },
    };
  });
}

export { financialsFor };
