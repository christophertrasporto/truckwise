import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import { withTenant, type Db } from "../db";
import { customerDocumentTypes, customers, tripDocumentFiles, tripDocuments, trips } from "../db/schema";
import { HttpError } from "../errors";
import { authorize } from "../policy";
import { getScanner } from "../scan";
import { MAX_FILE_BYTES, sha256, sniffImage, storage } from "../storage";
import { checklist, type ChecklistItem } from "./document-state";
import { syncTripWithProof } from "./proof-state";
import { resolveDriverHauler } from "./scope";
import { activeAssignment, type Ctx, type TenantActor } from "./trips";

/**
 * Documents a client wants on file for every trip (signed receipt, weighing ticket, gate pass...). The owner decides
 * the list per client; each trip gets its own copy, and a trip cannot be billed until every required item is approved
 * or waived (see proof-state.ts).
 */

export const documentTypeInput = z.object({
  name: z.string().trim().min(2).max(100),
  instructions: z.string().trim().max(300).optional(),
  required: z.boolean().default(true),
  uploader: z.enum(["driver", "dispatcher", "either"]).default("either"),
});
export const documentTypePatch = documentTypeInput.partial().extend({ active: z.boolean().optional() });
export const reviewDocumentInput = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(300).optional() });
export const waiveDocumentInput = z.object({ reason: z.string().trim().min(3).max(300) });

// ---------------------------------------------------------------------------
// The client's standard list
// ---------------------------------------------------------------------------

export async function listDocumentTypes(actor: TenantActor, customerId: string) {
  authorize(actor, "customer:read");
  return withTenant(actor.tenantId, actor.userId, (db) =>
    db.select().from(customerDocumentTypes).where(eq(customerDocumentTypes.customerId, customerId)).orderBy(asc(customerDocumentTypes.position), asc(customerDocumentTypes.createdAt)),
  );
}

export async function addDocumentType(actor: TenantActor, customerId: string, input: z.input<typeof documentTypeInput>, ctx: Ctx = {}) {
  authorize(actor, "document:configure");
  const v = documentTypeInput.parse(input);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId));
    if (!c) throw new HttpError(404, "Client not found");
    const [{ next }] = await db.select({ next: sql<number>`coalesce(max(${customerDocumentTypes.position}), 0) + 1` }).from(customerDocumentTypes).where(eq(customerDocumentTypes.customerId, customerId));
    const [row] = await db.insert(customerDocumentTypes).values({ ...v, tenantId: actor.tenantId, customerId, position: next }).returning({ id: customerDocumentTypes.id });
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "document_type.add", entityType: "customer_document_type", entityId: row.id, newValue: { customerId, ...v }, requestId: ctx.requestId });
    return { id: row.id };
  });
}

export async function updateDocumentType(actor: TenantActor, id: string, patch: z.input<typeof documentTypePatch>, ctx: Ctx = {}) {
  authorize(actor, "document:configure");
  const v = documentTypePatch.parse(patch);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [old] = await db.select().from(customerDocumentTypes).where(eq(customerDocumentTypes.id, id)).for("update");
    if (!old) throw new HttpError(404, "Document type not found");
    await db.update(customerDocumentTypes).set(v).where(eq(customerDocumentTypes.id, id));
    await writeAudit(db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "document_type.update",
      entityType: "customer_document_type",
      entityId: id,
      oldValue: { name: old.name, required: old.required, uploader: old.uploader, active: old.active },
      newValue: v,
      requestId: ctx.requestId,
    });
  });
}

/** Copies the client's current list onto a new trip. Runs inside createTrip's transaction. */
export async function copyRequirementsToTrip(db: Db, tenantId: string, tripId: string, customerId: string) {
  const types = await db
    .select()
    .from(customerDocumentTypes)
    .where(and(eq(customerDocumentTypes.customerId, customerId), eq(customerDocumentTypes.active, true)))
    .orderBy(asc(customerDocumentTypes.position), asc(customerDocumentTypes.createdAt));
  if (types.length === 0) return;
  await db.insert(tripDocuments).values(
    types.map((t, i) => ({ tenantId, tripId, sourceTypeId: t.id, name: t.name, instructions: t.instructions, required: t.required, uploader: t.uploader, position: i + 1 })),
  );
}

// ---------------------------------------------------------------------------
// One trip's checklist
// ---------------------------------------------------------------------------

const STAFF = new Set(["owner", "ops_manager", "dispatcher"]);
/** The statuses in which paperwork can be uploaded: from arrival at the destination until the trip is billed. */
const UPLOAD_STATUSES = new Set(["arrived_destination", "pod_submitted", "delivery_exception"]);

/** Which company's data this person is looking at: their own for staff and company drivers, the hauler for a subcontractor's driver. */
async function tenantFor(actor: TenantActor, tripId: string): Promise<string> {
  if (STAFF.has(actor.role ?? "") || actor.isPlatformAdmin) return actor.tenantId;
  if (actor.role === "driver" || actor.role === "sub_driver") {
    const tenantId = await resolveDriverHauler(actor, tripId);
    // A company driver is trusted with their own company only; they must also be the one assigned to this trip.
    const mine = await withTenant(tenantId, actor.userId, async (db) => {
      const a = await activeAssignment(db, tripId);
      return !!a && a.driverUserId === actor.userId;
    });
    if (!mine) throw new HttpError(404, "Trip not found");
    return tenantId;
  }
  throw new HttpError(404, "Trip not found");
}

export interface ChecklistView {
  tripStatus: string;
  items: (Omit<ChecklistItem, "latest"> & {
    canUpload: boolean;
    latest: { id: string; version: number; filename: string; status: string; reviewNote: string | null; uploadedAt: string; url: string } | null;
  })[];
  outstanding: string[];
  canManage: boolean;
  canReview: boolean;
}

export async function getChecklist(actor: TenantActor, tripId: string): Promise<ChecklistView> {
  const tenantId = await tenantFor(actor, tripId);
  const isStaff = STAFF.has(actor.role ?? "") || actor.isPlatformAdmin;
  return withTenant(tenantId, actor.userId, async (db) => {
    const [trip] = await db.select({ status: trips.status }).from(trips).where(eq(trips.id, tripId));
    if (!trip) throw new HttpError(404, "Trip not found");
    const items = await checklist(db, tripId);
    const open = UPLOAD_STATUSES.has(trip.status);
    return {
      tripStatus: trip.status,
      items: items.map((i) => ({
        ...i,
        canUpload: open && (i.state === "missing" || i.state === "rejected") && (isStaff || i.uploader === "driver" || i.uploader === "either"),
        latest: i.latest
          ? { id: i.latest.id, version: i.latest.version, filename: i.latest.filename, status: i.latest.status, reviewNote: i.latest.reviewNote, uploadedAt: i.latest.uploadedAt.toISOString(), url: storage.signedUrl(i.latest.objectKey, 300) }
          : null,
      })),
      outstanding: items.filter((i) => i.required && i.state !== "approved" && i.state !== "waived").map((i) => i.name),
      canManage: isStaff && ["owner", "ops_manager"].includes(actor.role ?? ""),
      canReview: isStaff,
    };
  });
}

/** After anything that could change whether the trip may be billed, let the trip catch up. Only a trip waiting on its paperwork moves. */
async function resync(db: Db, tripId: string, actor: TenantActor, ctx: Ctx, note: string) {
  const [t] = await db.select({ status: trips.status }).from(trips).where(eq(trips.id, tripId));
  if (t?.status === "pod_submitted") await syncTripWithProof(db, tripId, actor, ctx, note);
}

export async function uploadDocument(actor: TenantActor, tripId: string, documentId: string, file: { name: string; data: Buffer }, ctx: Ctx = {}) {
  const isWorker = actor.role === "driver" || actor.role === "sub_driver";
  if (!isWorker) authorize(actor, "pod:submit_proxy");
  const tenantId = await tenantFor(actor, tripId);

  if (file.data.length === 0) throw new HttpError(400, "That file is empty");
  if (file.data.length > MAX_FILE_BYTES) throw new HttpError(400, `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const img = sniffImage(file.data);
  const isPdf = file.data.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!img && !isPdf) throw new HttpError(400, "Upload a photo (JPEG, PNG, WebP) or a PDF");
  const kind = img ?? { mime: "application/pdf", ext: "pdf" };
  const scan = await getScanner().scan(file.data);
  if (scan.status === "infected") throw new HttpError(400, "That file failed the security check and was not accepted");
  if (scan.status === "error") throw new HttpError(503, "We could not check that file right now. Please try again in a few minutes.");

  return withTenant(tenantId, actor.userId, async (db) => {
    const [trip] = await db.select({ id: trips.id, status: trips.status }).from(trips).where(eq(trips.id, tripId)).for("update");
    if (!trip) throw new HttpError(404, "Trip not found");
    if (!UPLOAD_STATUSES.has(trip.status)) throw new HttpError(409, "Documents can be uploaded once the trip has arrived at the destination");
    const [doc] = await db.select().from(tripDocuments).where(and(eq(tripDocuments.id, documentId), eq(tripDocuments.tripId, tripId), isNull(tripDocuments.removedAt)));
    if (!doc) throw new HttpError(404, "Document not found");
    if (isWorker && doc.uploader === "dispatcher") throw new HttpError(403, "Dispatch uploads this one");
    if (doc.waivedAt) throw new HttpError(409, "This document was waived for this trip");
    const [last] = await db
      .select({ version: tripDocumentFiles.version, status: tripDocumentFiles.status })
      .from(tripDocumentFiles)
      .where(eq(tripDocumentFiles.documentId, documentId))
      .orderBy(sql`${tripDocumentFiles.version} desc`)
      .limit(1);
    if (last && (last.status === "pending" || last.status === "approved")) throw new HttpError(409, last.status === "approved" ? "This document is already approved" : "This document is waiting for review");
    const version = (last?.version ?? 0) + 1;
    const key = `tenants/${tenantId}/trips/${tripId}/documents/${documentId}/v${version}.${kind.ext}`;
    await storage.put(key, file.data);
    const [row] = await db
      .insert(tripDocumentFiles)
      .values({ tenantId, documentId, version, objectKey: key, originalFilename: file.name.slice(0, 200), mimeType: kind.mime, sizeBytes: file.data.length, sha256: sha256(file.data), uploadedBy: actor.userId })
      .returning({ id: tripDocumentFiles.id });
    await writeAudit(db, { tenantId, actorUserId: actor.userId, action: "trip_document.upload", entityType: "trip_document", entityId: documentId, newValue: { name: doc.name, version, tripId }, requestId: ctx.requestId });
    return { id: row.id, version };
  });
}

export async function reviewDocument(actor: TenantActor, fileId: string, input: z.input<typeof reviewDocumentInput>, ctx: Ctx = {}) {
  authorize(actor, "pod:review");
  const v = reviewDocumentInput.parse(input);
  if (v.decision === "reject" && !v.note) throw new HttpError(400, "Say what is wrong so it can be sent again");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [f] = await db.select().from(tripDocumentFiles).where(eq(tripDocumentFiles.id, fileId)).for("update");
    if (!f) throw new HttpError(404, "Document not found");
    if (f.status !== "pending") throw new HttpError(409, `This document was already ${f.status}`);
    const [doc] = await db.select().from(tripDocuments).where(eq(tripDocuments.id, f.documentId));
    await db.update(tripDocumentFiles).set({ status: v.decision === "approve" ? "approved" : "rejected", reviewedBy: actor.userId, reviewedAt: new Date(), reviewNote: v.note }).where(eq(tripDocumentFiles.id, fileId));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: `trip_document.${v.decision}`, entityType: "trip_document", entityId: f.documentId, newValue: { name: doc.name, version: f.version, note: v.note ?? null }, requestId: ctx.requestId });
    await resync(db, doc.tripId, actor, ctx, `Documents: ${doc.name} ${v.decision === "approve" ? "approved" : "rejected"}`);
    return { status: v.decision === "approve" ? ("approved" as const) : ("rejected" as const) };
  });
}

/** The client does not need this one for this trip. Owner or operations manager only, with a reason on record. */
export async function waiveDocument(actor: TenantActor, documentId: string, input: z.input<typeof waiveDocumentInput>, ctx: Ctx = {}) {
  authorize(actor, "document:configure");
  const v = waiveDocumentInput.parse(input);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [doc] = await db.select().from(tripDocuments).where(and(eq(tripDocuments.id, documentId), isNull(tripDocuments.removedAt))).for("update");
    if (!doc) throw new HttpError(404, "Document not found");
    await assertEditable(db, doc.tripId);
    if (doc.waivedAt) throw new HttpError(409, "Already waived");
    await db.update(tripDocuments).set({ waivedAt: new Date(), waivedBy: actor.userId, waiveReason: v.reason }).where(eq(tripDocuments.id, documentId));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "trip_document.waive", entityType: "trip_document", entityId: documentId, newValue: { name: doc.name, reason: v.reason }, requestId: ctx.requestId });
    await resync(db, doc.tripId, actor, ctx, `Documents: ${doc.name} waived`);
  });
}

async function assertEditable(db: Db, tripId: string) {
  const [t] = await db.select({ status: trips.status }).from(trips).where(eq(trips.id, tripId));
  if (!t) throw new HttpError(404, "Trip not found");
  if (t.status === "ready_for_invoice" || t.status === "cancelled") throw new HttpError(409, "This trip is closed; its documents can no longer be changed");
}

/** Add an item to ONE trip's list (the client's standard list is untouched). */
export async function addTripDocument(actor: TenantActor, tripId: string, input: z.input<typeof documentTypeInput>, ctx: Ctx = {}) {
  authorize(actor, "customer:write");
  const v = documentTypeInput.parse(input);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    await assertEditable(db, tripId);
    const [{ next }] = await db.select({ next: sql<number>`coalesce(max(${tripDocuments.position}), 0) + 1` }).from(tripDocuments).where(eq(tripDocuments.tripId, tripId));
    const [row] = await db.insert(tripDocuments).values({ ...v, tenantId: actor.tenantId, tripId, position: next }).returning({ id: tripDocuments.id });
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "trip_document.add", entityType: "trip_document", entityId: row.id, newValue: { tripId, ...v }, requestId: ctx.requestId });
    return { id: row.id };
  });
}

/** Take an item off this trip's list. Its uploads stay on record. */
export async function removeTripDocument(actor: TenantActor, documentId: string, ctx: Ctx = {}) {
  authorize(actor, "customer:write");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [doc] = await db.select().from(tripDocuments).where(and(eq(tripDocuments.id, documentId), isNull(tripDocuments.removedAt))).for("update");
    if (!doc) throw new HttpError(404, "Document not found");
    await assertEditable(db, doc.tripId);
    await db.update(tripDocuments).set({ removedAt: new Date() }).where(eq(tripDocuments.id, documentId));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "trip_document.remove", entityType: "trip_document", entityId: documentId, newValue: { name: doc.name }, requestId: ctx.requestId });
    await resync(db, doc.tripId, actor, ctx, `Documents: ${doc.name} no longer needed`);
  });
}
