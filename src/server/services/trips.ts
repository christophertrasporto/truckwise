import { copyRequirementsToTrip } from "./documents";
import { and, asc, desc, eq } from "drizzle-orm";
import { assertTransition, driverSteps, type TripStatus } from "@/shared/state-machines/trip";
import type { CreateTripInput } from "@/shared/schemas/trip";
import { writeAudit } from "../audit";
import { withTenant, type Db } from "../db";
import {
  customers,
  memberships,
  tripApplications,
  tripAssignments,
  tripOffers,
  tripSlots,
  tripStatusEvents,
  tripStops,
  trips,
  users,
} from "../db/schema";
import { staffTrip } from "../dto/trip";
import { emitEvent } from "../notify/events";
import { HttpError, isUniqueViolation } from "../errors";
import { authorize, type Actor } from "../policy";
import { resolveDriverHauler } from "./scope";

export type TenantActor = Actor & { tenantId: string };
export type Ctx = { requestId?: string };

type TripRow = typeof trips.$inferSelect;

/**
 * Moves a trip along the state machine: conditional update + status event + audit, in the caller's
 * transaction. `actor` is null for system moves (for example an offer timing out).
 */
export async function moveTrip(
  db: Db,
  trip: Pick<TripRow, "id" | "status" | "tenantId">,
  to: TripStatus,
  actor: { userId: string } | null,
  ctx: Ctx,
  note?: string,
) {
  assertTransition(trip.status, to);
  const updated = await db
    .update(trips)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(trips.id, trip.id), eq(trips.status, trip.status)))
    .returning({ id: trips.id });
  if (updated.length === 0) throw new HttpError(409, "Trip was changed by someone else. Reload and try again.");
  const [event] = await db
    .insert(tripStatusEvents)
    .values({
      tenantId: trip.tenantId,
      tripId: trip.id,
      fromStatus: trip.status,
      toStatus: to,
      actorUserId: actor?.userId ?? null,
      note: note ?? null,
    })
    .returning({ id: tripStatusEvents.id });
  if (to === "arrived_pickup" || to === "arrived_destination" || to === "ready_for_invoice") {
    await emitEvent(db, { type: "trip.status", tenantId: trip.tenantId, tripId: trip.id, eventId: event.id, to });
  }
  await writeAudit(db, {
    tenantId: trip.tenantId,
    actorUserId: actor?.userId ?? null,
    action: "trip.status",
    entityType: "trip",
    entityId: trip.id,
    oldValue: { status: trip.status },
    newValue: { status: to, note: note ?? null },
    requestId: ctx.requestId,
  });
}

/** Locks the trip row for the rest of the transaction. Returns null if it does not exist in this tenant. */
export async function lockTrip(db: Db, tripId: string): Promise<TripRow | null> {
  const [row] = await db.select().from(trips).where(eq(trips.id, tripId)).for("update");
  return row ?? null;
}

export async function activeAssignment(db: Db, tripId: string) {
  const [a] = await db
    .select()
    .from(tripAssignments)
    .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.status, "active")))
    .limit(1);
  return a ?? null;
}

// ---------------------------------------------------------------------------
// Dispatch staff
// ---------------------------------------------------------------------------

export async function createTrip(actor: TenantActor, input: CreateTripInput, ctx: Ctx = {}) {
  authorize(actor, "trip:create");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    // The FK alone would accept another tenant's customer id; reading it through RLS proves it is ours.
    const [customer] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId));
    if (!customer) throw new HttpError(400, "Unknown client");

    let trip: TripRow;
    try {
      [trip] = await db
        .insert(trips)
        .values({
          tenantId: actor.tenantId,
          customerId: input.customerId,
          reference: input.reference,
          cargoDescription: input.cargoDescription,
          cargoType: input.cargoType,
          weightKg: input.weightKg,
          quantity: input.quantity,
          truckRequirement: input.truckRequirement,
          handlingInstructions: input.handlingInstructions,
          notes: input.notes,
          contractRateCentavos: input.contractRateCentavos,
          payoutCentavos: input.payoutCentavos,
          subcontractorPayoutCentavos: input.subcontractorPayoutCentavos,
          helperPayCentavos: input.helperPayCentavos ?? 0,
          fuelIncluded: input.fuelIncluded,
          tollIncluded: input.tollIncluded,
          createdBy: actor.userId,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "A trip with this reference already exists");
      throw err;
    }

    await db.insert(tripStops).values(
      input.stops.map((s, i) => ({
        tenantId: actor.tenantId,
        tripId: trip.id,
        seq: i + 1,
        kind: s.kind,
        address: s.address,
        requiredArrivalAt: s.requiredArrivalAt ? new Date(s.requiredArrivalAt) : null,
      })),
    );
    await db.insert(tripSlots).values({ tenantId: actor.tenantId, tripId: trip.id, slotNo: 1 });
    await copyRequirementsToTrip(db, actor.tenantId, trip.id, input.customerId);
    await db.insert(tripStatusEvents).values({
      tenantId: actor.tenantId,
      tripId: trip.id,
      fromStatus: null,
      toStatus: "created",
      actorUserId: actor.userId,
    });
    await writeAudit(db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "trip.create",
      entityType: "trip",
      entityId: trip.id,
      newValue: {
        reference: trip.reference,
        contractRateCentavos: trip.contractRateCentavos,
        payoutCentavos: trip.payoutCentavos,
        subcontractorPayoutCentavos: trip.subcontractorPayoutCentavos,
        helperPayCentavos: trip.helperPayCentavos,
      },
      requestId: ctx.requestId,
    });
    return { id: trip.id };
  });
}

export async function listTripsForStaff(actor: TenantActor) {
  authorize(actor, "trip:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ trip: trips, customerName: customers.name })
      .from(trips)
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .orderBy(desc(trips.createdAt));
    return rows.map((r) => staffTrip(r.trip, r.customerName));
  });
}

export async function cancelTrip(actor: TenantActor, tripId: string, ctx: Ctx = {}) {
  authorize(actor, "trip:cancel");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const trip = await lockTrip(db, tripId);
    if (!trip) throw new HttpError(404, "Trip not found");
    await moveTrip(db, trip, "cancelled", actor, ctx);
    const now = new Date();
    await db
      .update(tripOffers)
      .set({ status: "cancelled", respondedAt: now })
      .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, "open")));
    await db
      .update(tripApplications)
      .set({ status: "declined", decidedAt: now, decisionReason: "Trip cancelled" })
      .where(and(eq(tripApplications.tripId, tripId), eq(tripApplications.status, "pending")));
    await db
      .update(tripAssignments)
      .set({ status: "released", releasedAt: now, releasedBy: actor.userId, releasedReason: "Trip cancelled" })
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.status, "active")));
    await emitEvent(db, { type: "trip.cancelled", tenantId: actor.tenantId, tripId });
  });
}

export async function listActiveDrivers(actor: TenantActor) {
  authorize(actor, "trip:offer");
  return withTenant(actor.tenantId, actor.userId, async (db) =>
    db
      .select({ id: users.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, actor.tenantId), eq(memberships.role, "driver"), eq(memberships.status, "active")))
      .orderBy(asc(users.name)),
  );
}

// ---------------------------------------------------------------------------
// Drivers (internal and subcontractor): run an assigned trip
// ---------------------------------------------------------------------------

/** The assigned driver advances their own trip one step at a time. */
export async function advanceTrip(actor: TenantActor, tripId: string, to: TripStatus, ctx: Ctx = {}) {
  authorize(actor, "trip:drive");
  const hauler = await resolveDriverHauler(actor, tripId);
  return withTenant(hauler, actor.userId, async (db) => {
    const trip = await lockTrip(db, tripId);
    const assignment = trip && (await activeAssignment(db, tripId));
    if (!trip || !assignment || assignment.driverUserId !== actor.userId) throw new HttpError(404, "Trip not found");
    if (driverSteps[trip.status] !== to) {
      throw new HttpError(409, "That step is not available right now");
    }
    await moveTrip(db, trip, to, actor, ctx);
  });
}
