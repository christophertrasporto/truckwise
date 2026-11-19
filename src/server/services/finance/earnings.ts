import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "../../db";
import { customers, tripAssignments, tripExpenses, trips } from "../../db/schema";
import { authorize } from "../../policy";
import type { TenantActor } from "../trips";

/**
 * A company driver's own money: the payout for each of their trips (earned once the delivery is approved) and the
 * approved expenses the company will reimburse. It reads only this driver's rows and selects no customer rate.
 */
export async function driverEarnings(actor: TenantActor) {
  authorize(actor, "earnings:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ reference: trips.reference, status: trips.status, payout: trips.payoutCentavos, customerName: customers.name, tripId: trips.id })
      .from(tripAssignments)
      .innerJoin(trips, eq(trips.id, tripAssignments.tripId))
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .where(and(eq(tripAssignments.driverUserId, actor.userId), eq(tripAssignments.status, "active")))
      .orderBy(desc(trips.createdAt));
    const reimburse = await db
      .select({ tripId: tripExpenses.tripId, category: tripExpenses.category, amount: tripExpenses.amountCentavos })
      .from(tripExpenses)
      .where(and(eq(tripExpenses.paidByDriverId, actor.userId), eq(tripExpenses.status, "approved"), eq(tripExpenses.companyBears, true)));
    const trip = rows.map((r) => ({ tripId: r.tripId, reference: r.reference, customerName: r.customerName, status: r.status, payoutCentavos: r.payout, earned: r.status === "ready_for_invoice" }));
    return {
      trips: trip,
      earnedCentavos: trip.filter((t) => t.earned).reduce((n, t) => n + t.payoutCentavos, 0),
      pendingCentavos: trip.filter((t) => !t.earned && t.status !== "cancelled").reduce((n, t) => n + t.payoutCentavos, 0),
      reimbursementsCentavos: reimburse.reduce((n, e) => n + e.amount, 0),
    };
  });
}
