import { and, desc, eq } from "drizzle-orm";
import type { BoardFilters } from "@/shared/schemas/trip";
import { writeAudit } from "../audit";
import { withTenant } from "../db";
import { companySettings, customers, memberships, tripApplications, tripAssignments, tripOffers, trips } from "../db/schema";
import { partnerTrip, subcontractorPayout } from "../dto/trip";
import { HttpError, isUniqueViolation } from "../errors";
import { emitEvent } from "../notify/events";
import { authorize } from "../policy";
import { loadStopSummaries, matchesFilters } from "./board";
import { assertEligible, loadConflicts, loadTripNeeds, loadWorkerFacts, reasonsFor } from "./eligibility";
import { createAssignment, optionsFor, sweepExpiredOffers, visibleToPartner } from "./offers";
import { approvedHaulers, assertApprovedHauler, haulersWithMyAssignments } from "./scope";
import { lockTrip, moveTrip, type Ctx, type TenantActor } from "./trips";

/** Subcontractor portal. Every hauler-side read or write is preceded by assertApprovedHauler (see scope.ts). */

/** Offers made to my company by every hauler that currently approves it. */
export async function listPartnerBoard(actor: TenantActor, filters: BoardFilters = {}) {
  authorize(actor, "partner:accept");
  const items = [];
  for (const hauler of await approvedHaulers(actor)) {
    await sweepExpiredOffers(hauler.id);
    const rows = await withTenant(hauler.id, actor.userId, async (db) => {
      const found = await db
        .select({ trip: trips, customerName: customers.name, offer: tripOffers })
        .from(tripOffers)
        .innerJoin(trips, eq(trips.id, tripOffers.tripId))
        .innerJoin(customers, eq(customers.id, trips.customerId))
        .where(and(visibleToPartner(actor.tenantId, actor.userId), eq(trips.status, "offered")))
        .orderBy(desc(tripOffers.createdAt));
      const stops = await loadStopSummaries(db, found.map((f) => f.trip.id));
      const pending = await db
        .select({ offerId: tripApplications.offerId })
        .from(tripApplications)
        .where(and(eq(tripApplications.applicantTenantId, actor.tenantId), eq(tripApplications.status, "pending")));
      const requested = new Set(pending.map((p) => p.offerId));
      return found
        .filter((f) => matchesFilters({ ...f.trip, payoutCentavos: subcontractorPayout(f.trip) }, stops.get(f.trip.id), filters))
        .map((f) => ({
          ...partnerTrip(f.trip, f.customerName),
          haulerTenantId: hauler.id,
          haulerName: hauler.name,
          offerId: f.offer.id,
          offerMode: f.offer.mode,
          expiresAt: f.offer.expiresAt?.toISOString() ?? null,
          route: stops.get(f.trip.id) ?? null,
          requested: requested.has(f.offer.id),
        }));
    });
    items.push(...rows);
  }
  return { direct: items.filter((i) => i.offerMode === "direct"), broadcast: items.filter((i) => i.offerMode !== "direct") };
}

/** My trucks and drivers for one offered trip, each with the reasons it would be refused. */
export async function partnerOptions(actor: TenantActor, haulerId: string, tripId: string) {
  authorize(actor, "partner:accept");
  await assertApprovedHauler(actor, haulerId);
  return withTenant(haulerId, actor.userId, async (haulerDb) => {
    const [offer] = await haulerDb.select({ id: tripOffers.id }).from(tripOffers).where(and(eq(tripOffers.tripId, tripId), visibleToPartner(actor.tenantId, actor.userId))).limit(1);
    if (!offer) throw new HttpError(404, "Trip not found");
    return withTenant(actor.tenantId, actor.userId, async (workerDb) => {
      const drivers = await workerDb
        .select({ id: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.tenantId, actor.tenantId), eq(memberships.role, "sub_driver"), eq(memberships.status, "active")));
      if (drivers.length === 0) return { drivers: [], trucks: [] };
      return optionsFor(haulerDb, workerDb, { haulerTenantId: haulerId, tripId, driverUserIds: drivers.map((d) => d.id), driverRoles: ["sub_driver"], workerTenantId: actor.tenantId });
    });
  });
}

/**
 * Accept an offered trip for my company with one of my trucks and one of my drivers.
 * Follows the hauler's claim setting: immediate assignment, or a request the hauler's dispatch approves.
 */
export async function partnerAccept(actor: TenantActor, haulerId: string, tripId: string, input: { truckId: string; driverUserId: string }, ctx: Ctx = {}) {
  authorize(actor, "partner:accept");
  await assertApprovedHauler(actor, haulerId);
  // My truck and driver are read in MY tenant; the trip is read in the hauler's.
  const facts = await withTenant(actor.tenantId, actor.userId, (db) =>
    loadWorkerFacts(db, { tenantId: actor.tenantId, driverUserId: input.driverUserId, truckId: input.truckId, driverRoles: ["sub_driver"] }),
  );
  try {
    return await withTenant(haulerId, actor.userId, async (db) => {
      const trip = await lockTrip(db, tripId);
      if (!trip) throw new HttpError(404, "Trip not found");
      const [offer] = await db
        .select()
        .from(tripOffers)
        .where(and(eq(tripOffers.tripId, tripId), visibleToPartner(actor.tenantId, actor.userId)))
        .orderBy(desc(tripOffers.createdAt))
        .limit(1);
      if (!offer || trip.status !== "offered") throw new HttpError(409, "This trip is no longer available");

      const needs = await loadTripNeeds(db, tripId);
      const conflicts = await loadConflicts(db, { tripId, driverUserId: input.driverUserId, truckId: input.truckId });
      assertEligible(reasonsFor(needs, facts, conflicts));

      const worker = { assignedTenantId: actor.tenantId, driverUserId: input.driverUserId, driverName: facts.driverName, truckId: input.truckId, truckPlate: facts.truck?.plate ?? null };
      const [settings] = await db.select({ mode: companySettings.claimMode }).from(companySettings).where(eq(companySettings.tenantId, haulerId));
      if (offer.mode === "applicants" || (settings?.mode ?? "approval_required") === "approval_required") {
        const [app] = await db
          .insert(tripApplications)
          .values({ tenantId: haulerId, tripId, slotId: offer.slotId, offerId: offer.id, applicantUserId: actor.userId, applicantTenantId: actor.tenantId, truckId: input.truckId, driverUserId: input.driverUserId, truckPlate: worker.truckPlate, driverName: worker.driverName })
          .returning();
        await writeAudit(db, { tenantId: haulerId, actorUserId: actor.userId, action: "application.create", entityType: "trip_application", entityId: app.id, newValue: { tripId, partnerTenantId: actor.tenantId, truckId: input.truckId, driverUserId: input.driverUserId }, requestId: ctx.requestId });
        await emitEvent(db, { type: "application.created", tenantId: haulerId, tripId, applicationId: app.id });
        return { status: "pending" as const };
      }
      await writeAudit(db, { tenantId: haulerId, actorUserId: actor.userId, action: "offer.accept", entityType: "trip_offer", entityId: offer.id, newValue: { tripId, partnerTenantId: actor.tenantId }, requestId: ctx.requestId });
      await createAssignment(db, trip, offer, worker, actor, ctx, `Accepted by ${facts.driverName}'s company`, { via: "claim", applicantUserId: null });
      return { status: "assigned" as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "This trip is no longer available, or your company already requested it");
    throw err;
  }
}

/** Decline a direct offer made to my company. */
export async function partnerDecline(actor: TenantActor, haulerId: string, tripId: string, ctx: Ctx = {}) {
  authorize(actor, "partner:accept");
  await assertApprovedHauler(actor, haulerId);
  return withTenant(haulerId, actor.userId, async (db) => {
    const trip = await lockTrip(db, tripId);
    if (!trip) throw new HttpError(404, "Trip not found");
    const [offer] = await db
      .select()
      .from(tripOffers)
      .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, "open"), eq(tripOffers.mode, "direct"), eq(tripOffers.targetTenantId, actor.tenantId)));
    if (!offer) throw new HttpError(404, "No direct offer to decline");
    await db.update(tripOffers).set({ status: "declined", respondedAt: new Date() }).where(eq(tripOffers.id, offer.id));
    await writeAudit(db, { tenantId: haulerId, actorUserId: actor.userId, action: "offer.decline", entityType: "trip_offer", entityId: offer.id, newValue: { tripId, partnerTenantId: actor.tenantId }, requestId: ctx.requestId });
    await emitEvent(db, { type: "offer.declined", tenantId: haulerId, tripId, offerId: offer.id, byUserId: actor.userId });
    const open = await db.select({ id: tripOffers.id }).from(tripOffers).where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, "open"))).limit(1);
    if (open.length === 0 && trip.status === "offered") {
      await moveTrip(db, trip, "created", actor, ctx, "Direct offer declined by subcontractor");
    }
  });
}

/** Jobs assigned to my company and my pending requests, across haulers. */
export async function listPartnerWork(actor: TenantActor) {
  authorize(actor, "partner:accept");
  const haulers = new Map<string, string>();
  for (const h of [...(await approvedHaulers(actor)), ...(await haulersWithMyAssignments(actor))]) haulers.set(h.id, h.name);
  type Job = ReturnType<typeof partnerTrip> & { haulerTenantId: string; haulerName: string; driverName: string | null; truckPlate: string | null };
  const assigned: Job[] = [];
  const pending: Job[] = [];
  for (const [haulerId, haulerName] of haulers) {
    await withTenant(haulerId, actor.userId, async (db) => {
      const rows = await db
        .select({ trip: trips, customerName: customers.name, a: tripAssignments })
        .from(tripAssignments)
        .innerJoin(trips, eq(trips.id, tripAssignments.tripId))
        .innerJoin(customers, eq(customers.id, trips.customerId))
        .where(and(eq(tripAssignments.assignedTenantId, actor.tenantId), eq(tripAssignments.status, "active")))
        .orderBy(desc(trips.createdAt));
      for (const r of rows) assigned.push({ ...partnerTrip(r.trip, r.customerName), haulerTenantId: haulerId, haulerName, driverName: r.a.driverName, truckPlate: r.a.truckPlate });
      const apps = await db
        .select({ trip: trips, customerName: customers.name, app: tripApplications })
        .from(tripApplications)
        .innerJoin(trips, eq(trips.id, tripApplications.tripId))
        .innerJoin(customers, eq(customers.id, trips.customerId))
        .where(and(eq(tripApplications.applicantTenantId, actor.tenantId), eq(tripApplications.status, "pending")));
      for (const r of apps) pending.push({ ...partnerTrip(r.trip, r.customerName), haulerTenantId: haulerId, haulerName, driverName: r.app.driverName, truckPlate: r.app.truckPlate });
    });
  }
  return { assigned, pending };
}

/** Read-only trip view for my company: assigned to us, or currently offered to us. The contract rate is never in this shape. */
export async function getTripForPartner(actor: TenantActor, haulerId: string, tripId: string) {
  authorize(actor, "partner:accept");
  const approved = (await approvedHaulers(actor)).some((h) => h.id === haulerId);
  return withTenant(haulerId, actor.userId, async (db) => {
    const [row] = await db
      .select({ trip: trips, customerName: customers.name })
      .from(trips)
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .where(eq(trips.id, tripId));
    if (!row) throw new HttpError(404, "Trip not found");
    const [mine] = await db
      .select({ driverName: tripAssignments.driverName, truckPlate: tripAssignments.truckPlate, driverUserId: tripAssignments.driverUserId })
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.assignedTenantId, actor.tenantId), eq(tripAssignments.status, "active")));
    let offered = false;
    if (!mine && approved && row.trip.status === "offered") {
      const [o] = await db.select({ id: tripOffers.id }).from(tripOffers).where(and(eq(tripOffers.tripId, tripId), visibleToPartner(actor.tenantId, actor.userId))).limit(1);
      offered = !!o;
    }
    if (!mine && !offered) throw new HttpError(404, "Trip not found");
    const stops = (await loadStopSummaries(db, [tripId])).get(tripId);
    const [pending] = await db
      .select({ id: tripApplications.id })
      .from(tripApplications)
      .where(and(eq(tripApplications.tripId, tripId), eq(tripApplications.applicantTenantId, actor.tenantId), eq(tripApplications.status, "pending")));
    return { trip: partnerTrip(row.trip, row.customerName), stops: stops?.stops ?? [], assignment: mine ? { driverName: mine.driverName, truckPlate: mine.truckPlate } : null, offered, requested: !!pending };
  });
}
