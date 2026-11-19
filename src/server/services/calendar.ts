import { and, asc, eq, ne } from "drizzle-orm";
import { tripWindow } from "@/shared/eligibility";
import { withTenant } from "../db";
import { customers, tenants, tripAssignments, tripStops, trips } from "../db/schema";
import { authorize } from "../policy";
import type { TenantActor } from "./trips";

/**
 * Dispatch calendar: every live trip with a schedule that overlaps [from, from + days), plus the trips
 * that have no schedule yet. Windows follow the same rule as the eligibility checks.
 */
export async function calendarForStaff(actor: TenantActor, fromDay: string, days = 7) {
  authorize(actor, "trip:read");
  const start = new Date(`${fromDay}T00:00:00+08:00`); // Asia/Manila
  const end = new Date(start.getTime() + days * 86_400_000);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ trip: trips, customerName: customers.name })
      .from(trips)
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .where(ne(trips.status, "cancelled"));
    const stops = await db.select().from(tripStops).orderBy(asc(tripStops.seq));
    const assigns = await db
      .select({ a: tripAssignments, company: tenants.name })
      .from(tripAssignments)
      .innerJoin(tenants, eq(tenants.id, tripAssignments.assignedTenantId))
      .where(and(eq(tripAssignments.status, "active")));

    const entries = rows.map((r) => {
      const mine = stops.filter((s) => s.tripId === r.trip.id);
      const w = tripWindow(mine.map((s) => s.requiredArrivalAt));
      const a = assigns.find((x) => x.a.tripId === r.trip.id);
      return {
        id: r.trip.id,
        reference: r.trip.reference,
        status: r.trip.status,
        customerName: r.customerName,
        origin: mine.find((s) => s.kind === "pickup")?.address ?? null,
        destination: [...mine].reverse().find((s) => s.kind === "delivery")?.address ?? null,
        startsAt: w.start?.toISOString() ?? null,
        endsAt: w.end?.toISOString() ?? null,
        driverName: a?.a.driverName ?? null,
        truckPlate: a?.a.truckPlate ?? null,
        company: a && a.a.assignedTenantId !== actor.tenantId ? a.company : null,
      };
    });
    const scheduled = entries
      .filter((e) => e.startsAt && new Date(e.startsAt) < end && new Date(e.endsAt!) > start)
      .sort((x, y) => x.startsAt!.localeCompare(y.startsAt!));
    const unscheduled = entries.filter((e) => !e.startsAt && e.status !== "ready_for_invoice");
    return { from: fromDay, days, scheduled, unscheduled };
  });
}
