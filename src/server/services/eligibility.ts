import { and, asc, eq, sql } from "drizzle-orm";
import { evaluateEligibility, tripWindow, type DriverFacts, type Reason, type TripNeeds, type TruckFacts } from "@/shared/eligibility";
import type { Db } from "../db";
import { driverProfiles, memberships, tripStops, trips, trucks, users } from "../db/schema";
import { HttpError } from "../errors";

/** What the job demands. Read inside the hauler's context (the trip's owner). */
export async function loadTripNeeds(db: Db, tripId: string): Promise<TripNeeds> {
  const [t] = await db.select({ truckRequirement: trips.truckRequirement, weightKg: trips.weightKg }).from(trips).where(eq(trips.id, tripId));
  if (!t) throw new HttpError(404, "Trip not found");
  const stops = await db.select({ at: tripStops.requiredArrivalAt }).from(tripStops).where(eq(tripStops.tripId, tripId)).orderBy(asc(tripStops.seq));
  const w = tripWindow(stops.map((s) => s.at));
  return { truckRequirement: t.truckRequirement, weightKg: t.weightKg, windowStart: w.start, windowEnd: w.end };
}

export interface WorkerFacts {
  driverName: string;
  driver: DriverFacts;
  truck: (TruckFacts & { id: string; plate: string }) | null;
}

/**
 * The driver and truck that would do the job. Read inside the WORKER's own tenant context
 * (the hauler for an internal driver, the partner company for a subcontractor).
 */
export async function loadWorkerFacts(db: Db, input: { tenantId: string; driverUserId: string; truckId: string | null; driverRoles: ("driver" | "sub_driver")[] }): Promise<WorkerFacts> {
  const [m] = await db
    .select({ name: users.name, role: memberships.role, status: memberships.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, input.tenantId), eq(memberships.userId, input.driverUserId)));
  if (!m || m.status !== "active" || !(input.driverRoles as string[]).includes(m.role)) {
    throw new HttpError(400, "That person is not an active driver of this company");
  }
  const [p] = await db.select().from(driverProfiles).where(eq(driverProfiles.userId, input.driverUserId));
  let truck: WorkerFacts["truck"] = null;
  if (input.truckId) {
    const [t] = await db.select().from(trucks).where(eq(trucks.id, input.truckId));
    if (!t) throw new HttpError(400, "Unknown truck");
    truck = {
      id: t.id,
      plate: t.plate,
      truckType: t.truckType,
      capacityKg: t.capacityKg,
      status: t.status,
      registrationExpiry: t.registrationExpiry,
      inspectionExpiry: t.inspectionExpiry,
    };
  }
  return { driverName: m.name, driver: { licenseNumber: p?.licenseNumber ?? null, licenseExpiry: p?.licenseExpiry ?? null }, truck };
}

/** Schedule conflicts across ALL companies (security-definer SQL helpers return only booleans). */
export async function loadConflicts(db: Db, input: { tripId: string; driverUserId: string; truckId: string | null }) {
  const res = await db.execute<{ driver_busy: boolean; truck_busy: boolean }>(sql`
    select driver_has_conflict(${input.driverUserId}::uuid, trip_window(${input.tripId}::uuid), ${input.tripId}::uuid) as driver_busy,
           truck_has_conflict(${input.truckId}::uuid, trip_window(${input.tripId}::uuid), ${input.tripId}::uuid) as truck_busy`);
  const row = (res as unknown as { driver_busy: boolean; truck_busy: boolean }[])[0];
  return { driverBusy: !!row?.driver_busy, truckBusy: !!row?.truck_busy };
}

export function reasonsFor(needs: TripNeeds, facts: WorkerFacts, conflicts: { driverBusy: boolean; truckBusy: boolean }): Reason[] {
  return evaluateEligibility({ trip: needs, truck: facts.truck, driver: facts.driver, ...conflicts, now: new Date() });
}

/** Throws 422 with the reasons when the pairing is not allowed. */
export function assertEligible(reasons: Reason[]) {
  if (reasons.length > 0) {
    throw Object.assign(new HttpError(422, reasons.map((r) => r.message).join(" ")), { reasons });
  }
}

export { and };
