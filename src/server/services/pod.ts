import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { PodInput } from "@/shared/schemas/trip";
import { writeAudit } from "../audit";
import { withTenant } from "../db";
import { companySettings, epodAttachmentProcessing, epodAttachments, epodSubmissions, podReviews, tripStops, trips } from "../db/schema";
import { HttpError, isUniqueViolation } from "../errors";
import { readExifCapture } from "../files/images";
import { enqueue } from "../jobs/queue";
import { emitEvent } from "../notify/events";
import { authorize } from "../policy";
import { MAX_FILES, MAX_FILE_BYTES, sha256, sniffImage, storage } from "../storage";
import { stopProofs, syncTripWithProof } from "./proof-state";
import { resolveDriverHauler } from "./scope";
import { activeAssignment, lockTrip, type TenantActor } from "./trips";

type Ctx = { requestId?: string };

export type FileKind = "photo" | "signature" | "pdf";
export interface UploadedFile {
  name: string;
  data: Buffer;
  /** Defaults to "photo". */
  kind?: FileKind;
}

export const MAX_SIGNATURE_BYTES = 1024 * 1024;
export const MAX_PDFS = 3;

const isPdf = (b: Buffer) => b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-";

/**
 * Submit proof of delivery for ONE delivery stop (creates a new pending version for that stop).
 * Only the assigned driver may submit; ops staff may submit on the driver's behalf and both identities are recorded.
 * Files are checked by their real content, kept as untouched originals, and queued for malware scanning
 * and a compressed display copy. Partial/discrepancy/failed outcomes lead to a delivery exception.
 */
export async function submitPod(actor: TenantActor, tripId: string, input: PodInput, files: UploadedFile[], ctx: Ctx = {}) {
  const isWorker = actor.role === "driver" || actor.role === "sub_driver";
  const proxy = !isWorker;
  authorize(actor, proxy ? "pod:submit_proxy" : "pod:submit");

  const kinds = files.map((f) => f.kind ?? "photo");
  const photos = kinds.filter((k) => k === "photo").length;
  if (photos < 1) throw new HttpError(400, "Attach at least one photo");
  if (photos > MAX_FILES) throw new HttpError(400, `At most ${MAX_FILES} photos`);
  if (kinds.filter((k) => k === "signature").length > 1) throw new HttpError(400, "Only one signature");
  if (kinds.filter((k) => k === "pdf").length > MAX_PDFS) throw new HttpError(400, `At most ${MAX_PDFS} PDF receipts`);

  const sniffed = files.map((f, i) => {
    const kind = kinds[i];
    const limit = kind === "signature" ? MAX_SIGNATURE_BYTES : MAX_FILE_BYTES;
    if (f.data.length > limit) throw new HttpError(400, `${f.name} is larger than ${limit / 1024 / 1024} MB`);
    if (kind === "pdf") {
      if (!isPdf(f.data)) throw new HttpError(400, `${f.name} is not a PDF`);
      return { mime: "application/pdf", ext: "pdf" };
    }
    const img = sniffImage(f.data);
    if (!img || (kind === "signature" && img.mime !== "image/png")) {
      throw new HttpError(400, kind === "signature" ? "The signature must be a PNG image" : `${f.name} is not a supported image (JPEG, PNG or WebP)`);
    }
    return img;
  });
  const actualDeliveryAt = new Date(input.actualDeliveryAt);
  if (actualDeliveryAt.getTime() > Date.now() + 5 * 60_000) throw new HttpError(400, "Delivery time cannot be in the future");

  // Evidence belongs to the hauler that owns the trip, even when a subcontractor driver submits it.
  const tenantId = proxy ? actor.tenantId : await resolveDriverHauler(actor, tripId);

  // Cheap authorization and settings read before anything is written to storage.
  const pre = await withTenant(tenantId, actor.userId, async (db) => {
    const [t] = await db.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId));
    const a = t ? await activeAssignment(db, tripId) : null;
    const [s] = await db.select({ pdf: companySettings.allowPdfReceipts }).from(companySettings).where(eq(companySettings.tenantId, tenantId));
    return { a, pdf: s?.pdf ?? false };
  });
  if (!pre.a || (!proxy && pre.a.driverUserId !== actor.userId)) throw new HttpError(404, "Trip not found");
  if (kinds.includes("pdf") && !pre.pdf) throw new HttpError(400, "PDF receipts are not enabled for this company");

  const submissionId = randomUUID();
  const stored = await Promise.all(
    files.map(async (f, i) => {
      const id = randomUUID();
      const key = `tenants/${tenantId}/trips/${tripId}/pod/${submissionId}/${id}.${sniffed[i].ext}`;
      await storage.put(key, f.data);
      // Device-reported capture time from the image metadata, only when it states its own UTC offset.
      const captured = kinds[i] === "photo" ? readExifCapture(f.data) : null;
      return { id, key, name: f.name.slice(0, 200), mime: sniffed[i].mime, size: f.data.length, hash: sha256(f.data), kind: kinds[i], captured };
    }),
  );

  try {
    return await withTenant(tenantId, actor.userId, async (db) => {
      const [dupe] = await db.select().from(epodSubmissions).where(eq(epodSubmissions.idempotencyKey, input.idempotencyKey));
      if (dupe) {
        if (dupe.tripId !== tripId || dupe.recordedBy !== actor.userId) throw new HttpError(409, "Idempotency key already used");
        return { submissionId: dupe.id, version: dupe.version, duplicate: true as const };
      }

      const trip = await lockTrip(db, tripId);
      const assignment = trip && (await activeAssignment(db, tripId));
      if (!trip || !assignment) throw new HttpError(404, "Trip not found");
      if (!proxy && assignment.driverUserId !== actor.userId) throw new HttpError(404, "Trip not found");
      if (trip.status === "cancelled") throw Object.assign(new HttpError(409, "This trip was cancelled"), { code: "trip_cancelled" });
      if (trip.status !== "arrived_destination") {
        throw Object.assign(new HttpError(409, "Proof can be submitted once the trip has arrived at the destination"), { code: "wrong_state" });
      }

      const deliveryStops = await db
        .select({ id: tripStops.id })
        .from(tripStops)
        .where(and(eq(tripStops.tripId, tripId), eq(tripStops.kind, "delivery")))
        .orderBy(asc(tripStops.seq));
      const stopId = input.stopId ?? (deliveryStops.length === 1 ? deliveryStops[0].id : null);
      if (!stopId) throw new HttpError(400, "Choose which delivery stop this proof is for");
      if (!deliveryStops.some((s) => s.id === stopId)) throw new HttpError(400, "That is not a delivery stop of this trip");

      const [last] = await db
        .select({ version: epodSubmissions.version, status: epodSubmissions.status })
        .from(epodSubmissions)
        .where(eq(epodSubmissions.stopId, stopId))
        .orderBy(desc(epodSubmissions.version))
        .limit(1);
      if (last && (last.status === "pending" || last.status === "approved")) {
        throw Object.assign(new HttpError(409, "Proof for this stop was already submitted"), { code: "already_submitted" });
      }
      const version = (last?.version ?? 0) + 1;

      const consentGranted = input.gpsConsent === "granted";
      await db.insert(epodSubmissions).values({
        id: submissionId,
        tenantId,
        tripId,
        stopId,
        version,
        outcome: input.outcome,
        receiverName: input.receiverName,
        deliveredQuantity: input.deliveredQuantity,
        discrepancyNotes: input.discrepancyNotes,
        comments: input.comments,
        actualDeliveryAt,
        // uploaded_at is the server clock (column default); it is never copied from the driver's time.
        recordedBy: actor.userId,
        onBehalfOfUserId: proxy ? assignment.driverUserId : null,
        driverUserId: assignment.driverUserId,
        gpsConsent: input.gpsConsent,
        gpsLat: consentGranted ? input.gpsLat : null,
        gpsLng: consentGranted ? input.gpsLng : null,
        gpsAccuracyM: consentGranted ? input.gpsAccuracyM : null,
        idempotencyKey: input.idempotencyKey,
        submittedOffline: !!input.submittedOffline,
        // The phone's clock, kept as reported. It is never promoted to the delivery time or the upload time.
        deviceQueuedAt: input.deviceQueuedAt ? new Date(input.deviceQueuedAt) : null,
      });
      await db.insert(epodAttachments).values(
        stored.map((s) => ({
          id: s.id,
          tenantId,
          submissionId,
          objectKey: s.key,
          originalFilename: s.name,
          mimeType: s.mime,
          sizeBytes: s.size,
          sha256: s.hash,
          kind: s.kind,
          capturedAt: s.captured,
          capturedSource: s.captured ? "device_exif" : null,
        })),
      );
      await db.insert(epodAttachmentProcessing).values(stored.map((s) => ({ attachmentId: s.id, tenantId })));
      await enqueue(db, { tenantId, type: "pod.process_submission", payload: { submissionId }, dedupeKey: `pod-sub:${submissionId}` });

      await writeAudit(db, {
        tenantId,
        actorUserId: actor.userId,
        action: "pod.submit",
        entityType: "epod_submission",
        entityId: submissionId,
        newValue: { tripId, stopId, version, outcome: input.outcome, onBehalfOf: proxy ? assignment.driverUserId : null, offline: !!input.submittedOffline },
        requestId: ctx.requestId,
      });
      await syncTripWithProof(db, tripId, actor, ctx, `Proof v${version} submitted for a stop (${input.outcome})`);
      await emitEvent(db, { type: "pod.submitted", tenantId, tripId, submissionId });
      return { submissionId, version, duplicate: false as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw Object.assign(new HttpError(409, "Proof was already submitted for this stop. Reload and try again."), { code: "already_submitted" });
    throw err;
  }
}

const REVIEW_STATUS = { approve: "approved", reject: "rejected", request_more: "more_info_requested" } as const;

/** Approve, reject or request more proof for one stop. Earlier versions are kept; resubmission creates a new version. */
export async function reviewPod(
  actor: TenantActor,
  submissionId: string,
  input: { decision: "approve" | "reject" | "request_more"; reason?: string },
  ctx: Ctx = {},
) {
  authorize(actor, "pod:review");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [sub] = await db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId));
    if (!sub) throw new HttpError(404, "Proof not found");
    const trip = await lockTrip(db, sub.tripId);
    if (!trip) throw new HttpError(404, "Trip not found");

    // Re-read after taking the trip lock so two reviewers cannot both act on the same version.
    const [fresh] = await db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId));
    if (fresh.status !== "pending") throw new HttpError(409, "This proof has already been reviewed");
    const [latest] = await db
      .select({ id: epodSubmissions.id })
      .from(epodSubmissions)
      .where(sub.stopId ? eq(epodSubmissions.stopId, sub.stopId) : eq(epodSubmissions.tripId, trip.id))
      .orderBy(desc(epodSubmissions.version))
      .limit(1);
    if (latest.id !== submissionId) throw new HttpError(409, "A newer version of this proof exists");

    if (input.decision !== "approve" && !input.reason) throw new HttpError(400, "Give the driver a reason");
    if (input.decision === "approve" && sub.outcome !== "complete" && !input.reason) {
      throw new HttpError(400, "Explain why this delivery exception is accepted");
    }
    if (input.decision === "approve") {
      const mine = await db
        .select({ scan: epodAttachmentProcessing.scanStatus })
        .from(epodAttachmentProcessing)
        .innerJoin(epodAttachments, eq(epodAttachments.id, epodAttachmentProcessing.attachmentId))
        .where(eq(epodAttachments.submissionId, submissionId));
      if (mine.some((f) => f.scan === "infected")) throw new HttpError(409, "A file in this proof failed the malware scan. Reject it or ask for new proof.");
      if (mine.some((f) => f.scan === "pending" || f.scan === "error")) throw new HttpError(409, "The files are still being checked. Try again in a moment.");
    }

    await db.insert(podReviews).values({
      tenantId: actor.tenantId,
      submissionId,
      reviewerUserId: actor.userId,
      decision: input.decision,
      reason: input.reason ?? null,
    });
    await db.update(epodSubmissions).set({ status: REVIEW_STATUS[input.decision] }).where(eq(epodSubmissions.id, submissionId));
    await writeAudit(db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: `pod.${input.decision}`,
      entityType: "epod_submission",
      entityId: submissionId,
      oldValue: { status: sub.status },
      newValue: { status: REVIEW_STATUS[input.decision], reason: input.reason ?? null },
      requestId: ctx.requestId,
    });
    await syncTripWithProof(
      db,
      trip.id,
      actor,
      ctx,
      input.decision === "approve" ? "Proof approved" : `Proof ${input.decision === "reject" ? "rejected" : "needs more"}: ${input.reason}`,
    );
    await emitEvent(db, { type: "pod.reviewed", tenantId: actor.tenantId, tripId: trip.id, submissionId, decision: input.decision, automatic: false, reason: input.reason ?? null });
    const [after] = await db.select({ status: trips.status }).from(trips).where(eq(trips.id, trip.id));
    return { tripStatus: after.status };
  });
}

export { stopProofs };
