import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { BoardFilters, OfferInput } from "@/shared/schemas/trip";
import { writeAudit } from "../audit";
import { withContext, withTenant, type Db } from "../db";
import {
  companySettings,
  customers,
  memberships,
  partnerApprovals,
  tripApplications,
  tripAssignments,
  tripOfferTargets,
  tripOffers,
  tripSlots,
  trips,
  trucks,
} from "../db/schema";
import { driverTrip, subDriverTrip } from "../dto/trip";
import { HttpError, isUniqueViolation } from "../errors";
import { emitEvent } from "../notify/events";
import { authorize } from "../policy";
import { loadStopSummaries, matchesFilters } from "./board";
import { assertEligible, loadConflicts, loadTripNeeds, loadWorkerFacts, reasonsFor } from "./eligibility";
import { driverHaulerIds } from "./scope";
import { activeAssignment, lockTrip, moveTrip, type Ctx, type TenantActor } from "./trips";

type TripRow = typeof trips.$inferSelect;
type OfferRow = typeof tripOffers.$inferSelect;

// ---------------------------------------------------------------------------
// Who can see which offer
// ---------------------------------------------------------------------------

const notExpired = or(isNull(tripOffers.expiresAt), gt(tripOffers.expiresAt, sql`now()`));
const hasTarget = (userId: string) =>
  sql`exists (select 1 from trip_offer_targets t where t.offer_id = ${tripOffers.id} and t.target_user_id = ${userId})`;

/** Open offers an internal driver of the hauler may act on. */
export const visibleToInternalDriver = (userId: string) =>
  and(
    eq(tripOffers.status, "open"),
    notExpired,
    or(
      inArray(tripOffers.mode, ["broadcast_internal", "broadcast_all"]),
      and(eq(tripOffers.mode, "applicants"), inArray(tripOffers.audience, ["internal", "all"])),
      and(eq(tripOffers.mode, "direct"), eq(tripOffers.targetUserId, userId)),
      and(eq(tripOffers.mode, "selected"), hasTarget(userId)),
    ),
  );

/** Open offers a subcontractor company (and its owner/manager) may act on. The caller has verified the partnership. */
export const visibleToPartner = (partnerTenantId: string, userId: string) =>
  and(
    eq(tripOffers.status, "open"),
    notExpired,
    or(
      inArray(tripOffers.mode, ["broadcast_partners", "broadcast_all"]),
      and(eq(tripOffers.mode, "applicants"), inArray(tripOffers.audience, ["partners", "all"])),
      and(eq(tripOffers.mode, "direct"), eq(tripOffers.targetTenantId, partnerTenantId)),
      and(eq(tripOffers.mode, "selected"), hasTarget(userId)),
    ),
  );

// ---------------------------------------------------------------------------
// Dispatch staff: offer, cancel offer, applications, reassign
// ---------------------------------------------------------------------------

/** Withdraw every open offer and pending application of a trip (used when offers are replaced). */
async function withdrawOpenOffers(db: Db, tripId: string, why: string) {
  const now = new Date();
  await db.update(tripOffers).set({ status: "cancelled", respondedAt: now }).where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, "open")));
  await db
    .update(tripApplications)
    .set({ status: "declined", decidedAt: now, decisionReason: why })
    .where(and(eq(tripApplications.tripId, tripId), eq(tripApplications.status, "pending")));
}

export async function createOffer(actor: TenantActor, tripId: string, input: OfferInput, ctx: Ctx = {}) {
  authorize(actor, "trip:offer");
  if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) throw new HttpError(400, "The offer must expire in the future");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const trip = await lockTrip(db, tripId);
    if (!trip) throw new HttpError(404, "Trip not found");
    if (trip.status !== "created" && trip.status !== "offered") {
      throw new HttpError(409, `A trip that is ${trip.status.replace(/_/g, " ")} cannot be offered`);
    }

    const internalDriver = async (userId: string) => {
      const [m] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, actor.tenantId), eq(memberships.userId, userId), eq(memberships.role, "driver"), eq(memberships.status, "active")));
      if (!m) throw new HttpError(400, "That person is not an active driver in this company");
    };
    const approvedPartners = () =>
      db
        .select({ id: partnerApprovals.partnerTenantId })
        .from(partnerApprovals)
        .where(and(eq(partnerApprovals.tenantId, actor.tenantId), eq(partnerApprovals.status, "approved")));

    if (input.mode === "direct") {
      if (input.driverUserId) await internalDriver(input.driverUserId);
      else if (!(await approvedPartners()).some((p) => p.id === input.partnerTenantId)) throw new HttpError(400, "That company is not an approved subcontractor");
    }
    if (input.mode === "selected") for (const u of new Set(input.userIds)) await internalDriver(u);
    const audience = input.mode === "applicants" ? input.audience! : null;
    const reachesPartners = input.mode === "broadcast_partners" || input.mode === "broadcast_all" || audience === "partners" || audience === "all";
    if (reachesPartners && (await approvedPartners()).length === 0) throw new HttpError(400, "You have no approved subcontractors yet");

    const [slot] = await db.select().from(tripSlots).where(eq(tripSlots.tripId, tripId)).orderBy(asc(tripSlots.slotNo)).limit(1);
    await withdrawOpenOffers(db, tripId, "Replaced by a new offer");
    const [offer] = await db
      .insert(tripOffers)
      .values({
        tenantId: actor.tenantId,
        tripId,
        slotId: slot.id,
        mode: input.mode,
        targetUserId: input.mode === "direct" ? (input.driverUserId ?? null) : null,
        targetTenantId: input.mode === "direct" ? (input.partnerTenantId ?? null) : null,
        audience,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: actor.userId,
      })
      .returning();
    if (input.mode === "selected") {
      await db.insert(tripOfferTargets).values([...new Set(input.userIds)].map((u) => ({ tenantId: actor.tenantId, offerId: offer.id, targetUserId: u })));
    }
    await writeAudit(db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "offer.create",
      entityType: "trip_offer",
      entityId: offer.id,
      newValue: { tripId, mode: input.mode, audience, targetUserId: offer.targetUserId, targetTenantId: offer.targetTenantId, expiresAt: input.expiresAt ?? null },
      requestId: ctx.requestId,
    });
    if (trip.status === "created") await moveTrip(db, trip, "offered", actor, ctx, `Offered (${input.mode})`);
    await emitEvent(db, { type: "offer.created", tenantId: actor.tenantId, tripId, offerId: offer.id });
    return { offerId: offer.id };
  });
}

/** Withdraw an offer. If nothing else is open, the trip goes back to "created". */
export async function cancelOffer(actor: TenantActor, offerId: string, ctx: Ctx = {}) {
  authorize(actor, "trip:offer");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [o] = await db.select().from(tripOffers).where(eq(tripOffers.id, offerId));
    if (!o) throw new HttpError(404, "Offer not found");
    const trip = await lockTrip(db, o.tripId);
    if (!trip) throw new HttpError(404, "Trip not found");
    if (o.status !== "open") throw new HttpError(409, "That offer is no longer open");
    const now = new Date();
    await db.update(tripOffers).set({ status: "cancelled", respondedAt: now }).where(eq(tripOffers.id, offerId));
    await db
      .update(tripApplications)
      .set({ status: "declined", decidedAt: now, decisionReason: "Offer withdrawn" })
      .where(and(eq(tripApplications.offerId, offerId), eq(tripApplications.status, "pending")));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "offer.cancel", entityType: "trip_offer", entityId: offerId, newValue: { tripId: o.tripId }, requestId: ctx.requestId });
    await backToCreatedIfNoOffers(db, trip, actor, ctx, "Offer withdrawn");
  });
}

async function backToCreatedIfNoOffers(db: Db, trip: TripRow, actor: { userId: string } | null, ctx: Ctx, note: string) {
  if (trip.status !== "offered") return;
  const open = await db.select({ id: tripOffers.id }).from(tripOffers).where(and(eq(tripOffers.tripId, trip.id), eq(tripOffers.status, "open"))).limit(1);
  if (open.length === 0) await moveTrip(db, trip, "created", actor, ctx, note);
}

/**
 * Timeout handling: expire open offers whose time has passed, expire their pending applications and
 * return trips with no remaining offer to "created". Called whenever offers are read; a scheduled job
 * can call it too (`npm run jobs:expire`). Safe to run repeatedly.
 */
export async function sweepExpiredOffers(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (db) => {
    const due = await db
      .select({ id: tripOffers.id, tripId: tripOffers.tripId })
      .from(tripOffers)
      .where(and(eq(tripOffers.status, "open"), sql`${tripOffers.expiresAt} <= now()`));
    if (due.length === 0) return 0;
    const now = new Date();
    for (const tripId of new Set(due.map((d) => d.tripId))) {
      const trip = await lockTrip(db, tripId);
      await db
        .update(tripOffers)
        .set({ status: "expired", respondedAt: now })
        .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, "open"), sql`${tripOffers.expiresAt} <= now()`));
      await db
        .update(tripApplications)
        .set({ status: "expired", decidedAt: now, decisionReason: "Offer expired" })
        .where(and(eq(tripApplications.tripId, tripId), eq(tripApplications.status, "pending"), inArray(tripApplications.offerId, due.filter((d) => d.tripId === tripId).map((d) => d.id))));
      await writeAudit(db, { tenantId, actorUserId: null, action: "offer.expire", entityType: "trip", entityId: tripId, newValue: { offers: due.filter((d) => d.tripId === tripId).length } });
      for (const d of due.filter((x) => x.tripId === tripId)) await emitEvent(db, { type: "offer.expired", tenantId, tripId, offerId: d.id });
      if (trip) await backToCreatedIfNoOffers(db, trip, null, {}, "Offer expired");
    }
    return due.length;
  });
}

/** Everything that happens when a slot is filled: assignment, offers closed, other applications declined, trip assigned. */
export async function createAssignment(
  db: Db,
  trip: TripRow,
  offer: OfferRow | null,
  worker: { assignedTenantId: string; driverUserId: string; driverName: string; truckId: string | null; truckPlate: string | null },
  actor: { userId: string },
  ctx: Ctx,
  note: string,
  meta: { via: "claim" | "approval"; applicantUserId: string | null },
) {
  const [slot] = await db.select().from(tripSlots).where(eq(tripSlots.tripId, trip.id)).orderBy(asc(tripSlots.slotNo)).limit(1);
  const [a] = await db
    .insert(tripAssignments)
    .values({
      tenantId: trip.tenantId,
      tripId: trip.id,
      slotId: slot.id,
      driverUserId: worker.driverUserId,
      offerId: offer?.id ?? null,
      assignedTenantId: worker.assignedTenantId,
      truckId: worker.truckId,
      truckPlate: worker.truckPlate,
      driverName: worker.driverName,
    })
    .returning();
  const now = new Date();
  if (offer) await db.update(tripOffers).set({ status: "accepted", respondedAt: now }).where(eq(tripOffers.id, offer.id));
  await db
    .update(tripOffers)
    .set({ status: "cancelled", respondedAt: now })
    .where(and(eq(tripOffers.tripId, trip.id), eq(tripOffers.status, "open"), offer ? ne(tripOffers.id, offer.id) : sql`true`));
  const lostOut = await db
    .update(tripApplications)
    .set({ status: "declined", decidedAt: now, decisionReason: "Another assignment was made" })
    .where(and(eq(tripApplications.tripId, trip.id), eq(tripApplications.status, "pending")))
    .returning({ id: tripApplications.id });
  for (const l of lostOut) {
    await emitEvent(db, { type: "application.decided", tenantId: trip.tenantId, tripId: trip.id, applicationId: l.id, decision: "declined", reason: "Another assignment was made" });
  }
  await writeAudit(db, {
    tenantId: trip.tenantId,
    actorUserId: actor.userId,
    action: "assignment.create",
    entityType: "trip_assignment",
    entityId: a.id,
    newValue: { tripId: trip.id, assignedTenantId: worker.assignedTenantId, driverUserId: worker.driverUserId, truckId: worker.truckId },
    requestId: ctx.requestId,
  });
  await moveTrip(db, trip, "assigned", actor, ctx, note);
  await emitEvent(db, { type: "trip.claimed", tenantId: trip.tenantId, tripId: trip.id, assignmentId: a.id, via: meta.via, actorUserId: actor.userId, applicantUserId: meta.applicantUserId });
  return a;
}

async function claimMode(db: Db, tenantId: string) {
  const [s] = await db.select({ mode: companySettings.claimMode }).from(companySettings).where(eq(companySettings.tenantId, tenantId));
  return s?.mode ?? "approval_required";
}

/** Approve or decline a pending application (dispatch staff). Approving re-checks eligibility and fills the slot. */
export async function decideApplication(
  actor: TenantActor,
  applicationId: string,
  input: { decision: "approve" | "decline"; reason?: string },
  ctx: Ctx = {},
) {
  authorize(actor, "trip:offer");
  const pre = await withTenant(actor.tenantId, actor.userId, (db) => db.select().from(tripApplications).where(eq(tripApplications.id, applicationId)));
  const app0 = pre[0];
  if (!app0) throw new HttpError(404, "Application not found");

  // Facts about the applicant's own truck and driver live in the applicant's tenant: the hauler itself, or an approved partner.
  let remoteFacts: Awaited<ReturnType<typeof loadWorkerFacts>> | null = null;
  if (input.decision === "approve" && app0.applicantTenantId !== actor.tenantId) {
    const approved = await withTenant(actor.tenantId, actor.userId, (db) =>
      db
        .select({ id: partnerApprovals.id })
        .from(partnerApprovals)
        .where(and(eq(partnerApprovals.tenantId, actor.tenantId), eq(partnerApprovals.partnerTenantId, app0.applicantTenantId), eq(partnerApprovals.status, "approved"))),
    );
    if (approved.length === 0) throw new HttpError(409, "That subcontractor is no longer approved");
    remoteFacts = await withContext({ tenantId: app0.applicantTenantId, userId: actor.userId }, (db) =>
      loadWorkerFacts(db, { tenantId: app0.applicantTenantId, driverUserId: app0.driverUserId, truckId: app0.truckId, driverRoles: ["sub_driver"] }),
    );
  }

  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const trip = await lockTrip(db, app0.tripId);
    if (!trip) throw new HttpError(404, "Trip not found");
    const [app] = await db.select().from(tripApplications).where(eq(tripApplications.id, applicationId));
    if (!app || app.status !== "pending") throw new HttpError(409, "That request was already handled");
    const now = new Date();

    if (input.decision === "decline") {
      await db.update(tripApplications).set({ status: "declined", decidedBy: actor.userId, decidedAt: now, decisionReason: input.reason ?? null }).where(eq(tripApplications.id, applicationId));
      await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "application.decline", entityType: "trip_application", entityId: applicationId, newValue: { reason: input.reason ?? null }, requestId: ctx.requestId });
      await emitEvent(db, { type: "application.decided", tenantId: actor.tenantId, tripId: app.tripId, applicationId, decision: "declined", reason: input.reason ?? null });
      return { status: "declined" as const };
    }

    if (trip.status !== "offered") throw new HttpError(409, "This trip is no longer open for assignment");
    const [offer] = await db.select().from(tripOffers).where(eq(tripOffers.id, app.offerId));
    const facts = remoteFacts ?? (await loadWorkerFacts(db, { tenantId: actor.tenantId, driverUserId: app.driverUserId, truckId: app.truckId, driverRoles: ["driver"] }));
    const needs = await loadTripNeeds(db, trip.id);
    const conflicts = await loadConflicts(db, { tripId: trip.id, driverUserId: app.driverUserId, truckId: app.truckId });
    assertEligible(reasonsFor(needs, facts, conflicts));

    await db.update(tripApplications).set({ status: "approved", decidedBy: actor.userId, decidedAt: now, decisionReason: input.reason ?? null }).where(eq(tripApplications.id, applicationId));
    await createAssignment(
      db,
      trip,
      offer ?? null,
      { assignedTenantId: app.applicantTenantId, driverUserId: app.driverUserId, driverName: facts.driverName, truckId: app.truckId, truckPlate: facts.truck?.plate ?? null },
      actor,
      ctx,
      "Approved by dispatch",
      { via: "approval", applicantUserId: app.applicantUserId },
    );
    await emitEvent(db, { type: "application.decided", tenantId: actor.tenantId, tripId: app.tripId, applicationId, decision: "approved", reason: input.reason ?? null });
    return { status: "approved" as const };
  });
}

/** Take the job back from its driver (before cargo is loaded) so dispatch can offer it again. */
export async function reassignTrip(actor: TenantActor, tripId: string, reason: string, ctx: Ctx = {}) {
  authorize(actor, "trip:reassign");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const trip = await lockTrip(db, tripId);
    if (!trip) throw new HttpError(404, "Trip not found");
    const a = await activeAssignment(db, tripId);
    if (!a) throw new HttpError(409, "This trip has no active assignment");
    if (!["assigned", "started", "arrived_pickup"].includes(trip.status)) {
      throw new HttpError(409, "A trip can only be reassigned before the cargo is loaded");
    }
    await db
      .update(tripAssignments)
      .set({ status: "released", releasedAt: new Date(), releasedBy: actor.userId, releasedReason: reason })
      .where(eq(tripAssignments.id, a.id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "assignment.release", entityType: "trip_assignment", entityId: a.id, oldValue: { driverUserId: a.driverUserId, assignedTenantId: a.assignedTenantId }, newValue: { reason }, requestId: ctx.requestId });
    await moveTrip(db, trip, "created", actor, ctx, `Reassigned: ${reason}`);
    await emitEvent(db, { type: "assignment.released", tenantId: actor.tenantId, tripId, assignmentId: a.id, reason });
  });
}

// ---------------------------------------------------------------------------
// Internal drivers: the available-trips board, accepting, applying
// ---------------------------------------------------------------------------

export async function listDriverBoard(actor: TenantActor, filters: BoardFilters = {}) {
  authorize(actor, "trip:claim");
  await sweepExpiredOffers(actor.tenantId);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ trip: trips, customerName: customers.name, offer: tripOffers })
      .from(tripOffers)
      .innerJoin(trips, eq(trips.id, tripOffers.tripId))
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .where(and(visibleToInternalDriver(actor.userId), eq(trips.status, "offered")))
      .orderBy(desc(tripOffers.createdAt));
    const stops = await loadStopSummaries(db, rows.map((r) => r.trip.id));
    const mine = await db
      .select({ offerId: tripApplications.offerId, status: tripApplications.status })
      .from(tripApplications)
      .where(and(eq(tripApplications.applicantUserId, actor.userId), eq(tripApplications.status, "pending")));
    const pendingOffers = new Set(mine.map((m) => m.offerId));

    const items = [];
    for (const r of rows) {
      const summary = stops.get(r.trip.id);
      if (!matchesFilters(r.trip, summary, filters)) continue;
      const needs = await loadTripNeeds(db, r.trip.id);
      const facts = await loadWorkerFacts(db, { tenantId: actor.tenantId, driverUserId: actor.userId, truckId: null, driverRoles: ["driver"] });
      const conflicts = await loadConflicts(db, { tripId: r.trip.id, driverUserId: actor.userId, truckId: null });
      // Truck choice happens when accepting; here only the driver-level blockers are shown.
      const issues = reasonsFor(needs, facts, conflicts).filter((x) => ["no_license", "license_expired", "driver_busy"].includes(x.code));
      items.push({
        ...driverTrip(r.trip, r.customerName),
        offerId: r.offer.id,
        offerMode: r.offer.mode,
        expiresAt: r.offer.expiresAt?.toISOString() ?? null,
        route: summary ?? null,
        requested: pendingOffers.has(r.offer.id),
        issues: issues.map((x) => x.message),
      });
    }
    return { direct: items.filter((i) => i.offerMode === "direct"), broadcast: items.filter((i) => i.offerMode !== "direct") };
  });
}

/**
 * Accept an offered trip with one of your trucks. Depending on the company setting (and for open
 * "applicants" calls) this either assigns immediately or sends a request for dispatch approval.
 * Immediate claims are concurrency-safe: the trip row is locked FOR UPDATE, the trip must still be
 * `offered`, and a partial unique index allows only one active assignment per slot.
 */
export async function claimTrip(actor: TenantActor, tripId: string, input: { truckId: string }, ctx: Ctx = {}) {
  authorize(actor, "trip:claim");
  try {
    return await withTenant(actor.tenantId, actor.userId, async (db) => {
      const trip = await lockTrip(db, tripId);
      if (!trip) throw new HttpError(404, "Trip not found");
      const [offer] = await db
        .select()
        .from(tripOffers)
        .where(and(eq(tripOffers.tripId, tripId), visibleToInternalDriver(actor.userId)))
        .orderBy(desc(tripOffers.createdAt))
        .limit(1);
      // Same answer whether the offer was never mine or has already been taken.
      if (!offer || trip.status !== "offered") throw new HttpError(409, "This trip is no longer available");

      const facts = await loadWorkerFacts(db, { tenantId: actor.tenantId, driverUserId: actor.userId, truckId: input.truckId, driverRoles: ["driver"] });
      const needs = await loadTripNeeds(db, tripId);
      const conflicts = await loadConflicts(db, { tripId, driverUserId: actor.userId, truckId: input.truckId });
      assertEligible(reasonsFor(needs, facts, conflicts));

      const worker = { assignedTenantId: actor.tenantId, driverUserId: actor.userId, driverName: facts.driverName, truckId: input.truckId, truckPlate: facts.truck?.plate ?? null };
      if (offer.mode === "applicants" || (await claimMode(db, actor.tenantId)) === "approval_required") {
        const [app] = await db
          .insert(tripApplications)
          .values({ tenantId: actor.tenantId, tripId, slotId: offer.slotId, offerId: offer.id, applicantUserId: actor.userId, applicantTenantId: actor.tenantId, truckId: input.truckId, driverUserId: actor.userId, truckPlate: worker.truckPlate, driverName: worker.driverName })
          .returning();
        await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "application.create", entityType: "trip_application", entityId: app.id, newValue: { tripId, truckId: input.truckId }, requestId: ctx.requestId });
        await emitEvent(db, { type: "application.created", tenantId: actor.tenantId, tripId, applicationId: app.id });
        return { status: "pending" as const };
      }
      await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "offer.accept", entityType: "trip_offer", entityId: offer.id, newValue: { tripId }, requestId: ctx.requestId });
      await createAssignment(db, trip, offer, worker, actor, ctx, "Accepted by driver", { via: "claim", applicantUserId: null });
      return { status: "assigned" as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "This trip is no longer available, or you already requested it");
    throw err;
  }
}

/** Withdraw your own pending request. */
export async function withdrawApplication(actor: TenantActor, tripId: string, ctx: Ctx = {}) {
  authorize(actor, "trip:claim");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .update(tripApplications)
      .set({ status: "withdrawn", decidedAt: new Date(), decisionReason: "Withdrawn by driver" })
      .where(and(eq(tripApplications.tripId, tripId), eq(tripApplications.applicantUserId, actor.userId), eq(tripApplications.status, "pending")))
      .returning({ id: tripApplications.id });
    if (rows.length === 0) throw new HttpError(404, "No pending request to withdraw");
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "application.withdraw", entityType: "trip_application", entityId: rows[0].id, requestId: ctx.requestId });
  });
}

/** Decline a direct offer made to you. Broadcast offers are simply ignored by drivers who do not want them. */
export async function declineOffer(actor: TenantActor, tripId: string, ctx: Ctx = {}) {
  authorize(actor, "trip:claim");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const trip = await lockTrip(db, tripId);
    if (!trip) throw new HttpError(404, "Trip not found");
    const [offer] = await db
      .select()
      .from(tripOffers)
      .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, "open"), eq(tripOffers.mode, "direct"), eq(tripOffers.targetUserId, actor.userId)));
    if (!offer) throw new HttpError(404, "No direct offer to decline");
    await db.update(tripOffers).set({ status: "declined", respondedAt: new Date() }).where(eq(tripOffers.id, offer.id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "offer.decline", entityType: "trip_offer", entityId: offer.id, newValue: { tripId }, requestId: ctx.requestId });
    await emitEvent(db, { type: "offer.declined", tenantId: actor.tenantId, tripId, offerId: offer.id, byUserId: actor.userId });
    await backToCreatedIfNoOffers(db, trip, actor, ctx, "Direct offer declined");
  });
}

/** Trucks the driver could use for this trip, each with the reasons it would be refused. Drives the accept form. */
export async function truckOptionsForDriver(actor: TenantActor, tripId: string) {
  authorize(actor, "trip:claim");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [offer] = await db.select({ id: tripOffers.id }).from(tripOffers).where(and(eq(tripOffers.tripId, tripId), visibleToInternalDriver(actor.userId))).limit(1);
    if (!offer) throw new HttpError(404, "Trip not found");
    return optionsFor(db, db, { haulerTenantId: actor.tenantId, tripId, driverUserIds: [actor.userId], driverRoles: ["driver"], workerTenantId: actor.tenantId });
  });
}

/** Shared by the internal driver and partner accept forms: every truck and driver with its eligibility reasons. */
export async function optionsFor(
  haulerDb: Db,
  workerDb: Db,
  input: { haulerTenantId: string; tripId: string; driverUserIds: string[]; driverRoles: ("driver" | "sub_driver")[]; workerTenantId: string },
) {
  const needs = await loadTripNeeds(haulerDb, input.tripId);
  const allTrucks = await workerDb.select({ id: trucks.id }).from(trucks).orderBy(asc(trucks.plate));
  const drivers: { userId: string; name: string; reasons: string[] }[] = [];
  const trucksOut: { id: string; plate: string; truckType: string; capacityKg: number; reasons: string[] }[] = [];
  for (const d of input.driverUserIds) {
    const f = await loadWorkerFacts(workerDb, { tenantId: input.workerTenantId, driverUserId: d, truckId: null, driverRoles: input.driverRoles });
    const c = await loadConflicts(workerDb, { tripId: input.tripId, driverUserId: d, truckId: null });
    drivers.push({ userId: d, name: f.driverName, reasons: reasonsFor(needs, f, c).filter((r) => r.code !== "no_truck").map((r) => r.message) });
  }
  const someDriver = input.driverUserIds[0];
  for (const t of allTrucks) {
    const f = await loadWorkerFacts(workerDb, { tenantId: input.workerTenantId, driverUserId: someDriver, truckId: t.id, driverRoles: input.driverRoles });
    const c = await loadConflicts(workerDb, { tripId: input.tripId, driverUserId: someDriver, truckId: t.id });
    const truckOnly = reasonsFor(needs, f, c).filter((r) => r.code.startsWith("truck_"));
    trucksOut.push({ id: t.id, plate: f.truck!.plate, truckType: f.truck!.truckType, capacityKg: f.truck!.capacityKg, reasons: truckOnly.map((r) => r.message) });
  }
  return { drivers, trucks: trucksOut };
}

/** Trips assigned to me (internal driver, or a subcontractor's driver across the haulers who assigned them). */
export async function listMyTrips(actor: TenantActor) {
  authorize(actor, "trip:drive");
  const out: ((ReturnType<typeof driverTrip> | ReturnType<typeof subDriverTrip>) & { haulerTenantId: string; truckPlate: string | null })[] = [];
  for (const hauler of await driverHaulerIds(actor)) {
    const rows = await withTenant(hauler, actor.userId, (db) =>
      db
        .select({ trip: trips, customerName: customers.name, truckPlate: tripAssignments.truckPlate })
        .from(tripAssignments)
        .innerJoin(trips, eq(trips.id, tripAssignments.tripId))
        .innerJoin(customers, eq(customers.id, trips.customerId))
        .where(and(eq(tripAssignments.driverUserId, actor.userId), eq(tripAssignments.status, "active")))
        .orderBy(desc(trips.createdAt)),
    );
    for (const r of rows) {
      const base = actor.role === "sub_driver" ? subDriverTrip(r.trip, r.customerName) : driverTrip(r.trip, r.customerName);
      out.push({ ...base, haulerTenantId: hauler, truckPlate: r.truckPlate });
    }
  }
  return out;
}
