import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { driverSteps } from "@/shared/state-machines/trip";
import { withTenant, type Db } from "../db";
import {
  companySettings,
  customers,
  epodAttachmentProcessing,
  epodAttachments,
  epodSubmissions,
  podReviews,
  tenants,
  tripApplications,
  tripAssignments,
  tripOffers,
  tripStatusEvents,
  tripStops,
  trips,
  users,
} from "../db/schema";
import { staffTrip, subDriverTrip } from "../dto/trip";
import { HttpError } from "../errors";
import { authorize } from "../policy";
import { storage } from "../storage";
import { sweepExpiredOffers, visibleToInternalDriver } from "./offers";
import { stopProofs } from "./proof-state";
import { resolveDriverHauler } from "./scope";
import type { TenantActor } from "./trips";

const URL_TTL_SECONDS = 300;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function stopsFor(db: Db, tripId: string) {
  const rows = await db.select().from(tripStops).where(eq(tripStops.tripId, tripId)).orderBy(asc(tripStops.seq));
  return rows.map((s) => ({ id: s.id, seq: s.seq, kind: s.kind, address: s.address, requiredArrivalAt: iso(s.requiredArrivalAt) }));
}

/**
 * Submissions with attachments (signed, short-lived URLs) and review history. Caller must already be authorized.
 * A file that failed the malware scan gets NO url: it is quarantined and cannot be opened from here.
 */
async function proofFor(db: Db, tripId: string, opts: { includeRecorder: boolean }) {
  const subs = await db
    .select({ s: epodSubmissions, stopSeq: tripStops.seq, stopAddress: tripStops.address })
    .from(epodSubmissions)
    .leftJoin(tripStops, eq(tripStops.id, epodSubmissions.stopId))
    .where(eq(epodSubmissions.tripId, tripId))
    .orderBy(desc(epodSubmissions.uploadedAt));
  if (subs.length === 0) return [];
  const ids = subs.map((x) => x.s.id);
  const files = await db
    .select({ a: epodAttachments, p: epodAttachmentProcessing })
    .from(epodAttachments)
    .leftJoin(epodAttachmentProcessing, eq(epodAttachmentProcessing.attachmentId, epodAttachments.id))
    .where(inArray(epodAttachments.submissionId, ids));
  const reviews = await db
    .select({ r: podReviews, reviewerName: users.name })
    .from(podReviews)
    .leftJoin(users, eq(users.id, podReviews.reviewerUserId))
    .where(inArray(podReviews.submissionId, ids))
    .orderBy(asc(podReviews.createdAt));
  const names = opts.includeRecorder
    ? new Map(
        (
          await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, [...new Set(subs.flatMap((x) => [x.s.recordedBy, x.s.driverUserId]))]))
        ).map((u) => [u.id, u.name]),
      )
    : null;

  return subs.map(({ s, stopSeq, stopAddress }) => {
    const mine = files.filter((f) => f.a.submissionId === s.id);
    const file = (f: (typeof mine)[number]) => {
      const infected = f.p?.scanStatus === "infected";
      return {
        id: f.a.id,
        kind: f.a.kind as "photo" | "signature" | "pdf",
        filename: f.a.originalFilename,
        mimeType: f.a.mimeType,
        sizeBytes: f.a.sizeBytes,
        sha256: f.a.sha256,
        // Device-reported (read from the image metadata); null when the phone did not say. Never the upload time.
        capturedAt: iso(f.a.capturedAt),
        scan: (f.p?.scanStatus ?? "pending") as "pending" | "clean" | "infected" | "error",
        quarantined: infected,
        url: infected ? null : storage.signedUrl(f.a.objectKey, URL_TTL_SECONDS),
        displayUrl: !infected && f.p?.displayStatus === "ready" && f.p.displayKey ? storage.signedUrl(f.p.displayKey, URL_TTL_SECONDS) : null,
      };
    };
    return {
      id: s.id,
      stopId: s.stopId,
      stopSeq: stopSeq ?? null,
      stopAddress: stopAddress ?? null,
      version: s.version,
      status: s.status,
      outcome: s.outcome,
      receiverName: s.receiverName,
      deliveredQuantity: s.deliveredQuantity,
      discrepancyNotes: s.discrepancyNotes,
      comments: s.comments,
      // Separate clocks, never merged: what the driver says, what the server saw, and what the phone says about its queue.
      actualDeliveryAt: iso(s.actualDeliveryAt),
      actualDeliverySource: s.actualDeliverySource,
      deliveryVerification: s.deliveryVerification,
      uploadedAt: iso(s.uploadedAt),
      submittedOffline: s.submittedOffline,
      deviceQueuedAt: iso(s.deviceQueuedAt),
      gps: s.gpsConsent === "granted" && s.gpsLat != null ? { lat: s.gpsLat, lng: s.gpsLng, accuracyM: s.gpsAccuracyM } : null,
      gpsConsent: s.gpsConsent,
      ...(names
        ? {
            driverName: names.get(s.driverUserId) ?? null,
            recordedByName: names.get(s.recordedBy) ?? null,
            submittedOnBehalf: s.onBehalfOfUserId != null,
          }
        : {}),
      photos: mine.filter((f) => f.a.kind === "photo").map(file),
      signature: mine.filter((f) => f.a.kind === "signature").map(file)[0] ?? null,
      pdfs: mine.filter((f) => f.a.kind === "pdf").map(file),
      reviews: reviews
        .filter((x) => x.r.submissionId === s.id)
        .map((x) => ({ decision: x.r.decision, reason: x.r.reason, reviewerName: x.r.automatic ? "Automatic approval (company policy)" : (x.reviewerName ?? "Unknown"), automatic: x.r.automatic, at: iso(x.r.createdAt) })),
    };
  });
}

/** Full dispatch view of a trip. Includes the customer contract rate. */
export async function getTripForStaff(actor: TenantActor, tripId: string) {
  authorize(actor, "trip:read");
  await sweepExpiredOffers(actor.tenantId);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [row] = await db
      .select({ trip: trips, customerName: customers.name })
      .from(trips)
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .where(eq(trips.id, tripId));
    if (!row) throw new HttpError(404, "Trip not found");

    const [assignment] = await db
      .select({ a: tripAssignments, companyName: tenants.name })
      .from(tripAssignments)
      .innerJoin(tenants, eq(tenants.id, tripAssignments.assignedTenantId))
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.status, "active")));
    const offers = await db
      .select({ o: tripOffers, partnerName: tenants.name })
      .from(tripOffers)
      .leftJoin(tenants, eq(tenants.id, tripOffers.targetTenantId))
      .where(eq(tripOffers.tripId, tripId))
      .orderBy(desc(tripOffers.createdAt));
    const applications = await db
      .select({ app: tripApplications, companyName: tenants.name, applicantName: users.name })
      .from(tripApplications)
      .innerJoin(tenants, eq(tenants.id, tripApplications.applicantTenantId))
      .innerJoin(users, eq(users.id, tripApplications.applicantUserId))
      .where(eq(tripApplications.tripId, tripId))
      .orderBy(desc(tripApplications.createdAt));
    const events = await db
      .select({
        from: tripStatusEvents.fromStatus,
        to: tripStatusEvents.toStatus,
        note: tripStatusEvents.note,
        at: tripStatusEvents.createdAt,
        actorName: users.name,
      })
      .from(tripStatusEvents)
      .leftJoin(users, eq(users.id, tripStatusEvents.actorUserId))
      .where(eq(tripStatusEvents.tripId, tripId))
      .orderBy(asc(tripStatusEvents.id));

    return {
      trip: staffTrip(row.trip, row.customerName),
      stops: await stopsFor(db, tripId),
      driver: assignment
        ? {
            id: assignment.a.driverUserId,
            name: assignment.a.driverName ?? "",
            company: assignment.companyName,
            external: assignment.a.assignedTenantId !== actor.tenantId,
            truckPlate: assignment.a.truckPlate,
          }
        : null,
      offers: offers.map(({ o, partnerName }) => ({
        id: o.id,
        mode: o.mode,
        audience: o.audience,
        status: o.status,
        partnerName,
        expiresAt: iso(o.expiresAt),
        createdAt: iso(o.createdAt),
      })),
      applications: applications.map(({ app, companyName, applicantName }) => ({
        id: app.id,
        status: app.status,
        companyName,
        external: app.applicantTenantId !== actor.tenantId,
        applicantName,
        driverName: app.driverName,
        truckPlate: app.truckPlate,
        reason: app.decisionReason,
        createdAt: iso(app.createdAt),
      })),
      timeline: events.map((e) => ({ ...e, at: iso(e.at) })),
      proof: await proofFor(db, tripId, { includeRecorder: true }),
      stopProof: await stopProofs(db, tripId),
    };
  });
}

/**
 * A driver's view of a trip: only if they are assigned to it or hold an open offer for it.
 * Anything else is a 404, so a driver cannot tell whether another driver's trip exists.
 * The contract rate is not part of this shape.
 */
export async function getTripForDriver(actor: TenantActor, tripId: string) {
  authorize(actor, "trip:drive");
  // A subcontractor driver only ever sees trips assigned to them; resolving the hauler proves that.
  const hauler = actor.role === "sub_driver" ? await resolveDriverHauler(actor, tripId) : actor.tenantId;
  return withTenant(hauler, actor.userId, async (db) => {
    const [row] = await db
      .select({ trip: trips, customerName: customers.name })
      .from(trips)
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .where(eq(trips.id, tripId));
    if (!row) throw new HttpError(404, "Trip not found");

    const [mine] = await db
      .select({ id: tripAssignments.id, truckPlate: tripAssignments.truckPlate })
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.driverUserId, actor.userId), eq(tripAssignments.status, "active")));
    let offered = false;
    let directOffer = false;
    let requested = false;
    if (!mine && actor.role === "driver" && row.trip.status === "offered") {
      const open = await db
        .select({ mode: tripOffers.mode, target: tripOffers.targetUserId })
        .from(tripOffers)
        .where(and(eq(tripOffers.tripId, tripId), visibleToInternalDriver(actor.userId)));
      offered = open.length > 0;
      directOffer = open.some((o) => o.mode === "direct");
      const [pending] = await db
        .select({ id: tripApplications.id })
        .from(tripApplications)
        .where(and(eq(tripApplications.tripId, tripId), eq(tripApplications.applicantUserId, actor.userId), eq(tripApplications.status, "pending")));
      requested = !!pending;
    }
    if (!mine && !offered) throw new HttpError(404, "Trip not found");
    const [settings] = await db.select({ pdf: companySettings.allowPdfReceipts }).from(companySettings).where(eq(companySettings.tenantId, hauler));

    return {
      allowPdf: settings?.pdf ?? false,
      trip: subDriverTrip(row.trip, row.customerName),
      // Money is only for company drivers; a subcontractor's driver never receives these fields.
      money:
        actor.role === "sub_driver"
          ? null
          : { payoutCentavos: row.trip.payoutCentavos, fuelIncluded: row.trip.fuelIncluded, tollIncluded: row.trip.tollIncluded },
      stops: await stopsFor(db, tripId),
      assignedToMe: !!mine,
      truckPlate: mine?.truckPlate ?? null,
      directOffer,
      requested,
      nextStep: mine ? (driverSteps[row.trip.status] ?? null) : null,
      canSubmitProof: !!mine && row.trip.status === "arrived_destination",
      proof: mine ? await proofFor(db, tripId, { includeRecorder: false }) : [],
      stopProof: mine ? await stopProofs(db, tripId) : [],
    };
  });
}
