import { and, desc, eq } from "drizzle-orm";
import { writeAudit } from "../audit";
import { withContext, withTenant } from "../db";
import { companySettings, epodAttachmentProcessing, epodAttachments, epodSubmissions, podReviews, trips } from "../db/schema";
import { makeDisplayCopy } from "../files/images";
import { emitEvent } from "../notify/events";
import { getScanner } from "../scan";
import { syncTripWithProof } from "../services/proof-state";
import { storage } from "../storage";
import { registerJob } from "./queue";

/**
 * pod.process_submission: for every file of a proof submission, scan it for malware and, for photos,
 * make a compressed display copy; then, if company policy allows, approve clean complete deliveries
 * automatically. Idempotent: finished steps are skipped, so a retry only does what is left.
 */
async function processSubmission({ submissionId }: { submissionId: string }) {
  const sub = await withContext({ platform: true }, async (db) => {
    const [s] = await db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId));
    return s ?? null;
  });
  if (!sub) return; // nothing to do (never retried into a loop)

  const files = await withContext({ platform: true }, (db) =>
    db
      .select({ a: epodAttachments, p: epodAttachmentProcessing })
      .from(epodAttachments)
      .innerJoin(epodAttachmentProcessing, eq(epodAttachmentProcessing.attachmentId, epodAttachments.id))
      .where(eq(epodAttachments.submissionId, submissionId)),
  );

  const scanner = getScanner();
  for (const { a, p } of files) {
    const patch: Partial<typeof epodAttachmentProcessing.$inferInsert> = {};
    let original: Buffer | null = null;
    const load = async () => (original ??= await storage.get(a.objectKey));

    if (p.scanStatus === "pending" || p.scanStatus === "error") {
      const r = await scanner.scan(await load());
      patch.scanStatus = r.status;
      patch.scanDetail = r.status === "clean" ? null : r.detail;
      patch.scannedAt = new Date();
      if (r.status === "error") throw new Error(`scan failed for ${a.id}: ${r.detail}`); // retry later
    }
    const infected = (patch.scanStatus ?? p.scanStatus) === "infected";
    if (p.displayStatus === "pending") {
      if (a.kind !== "photo" || infected) {
        patch.displayStatus = "skipped";
      } else {
        try {
          const copy = await makeDisplayCopy(await load());
          const key = a.objectKey.replace(/\.[a-z]+$/, "") + ".display.jpg";
          await storage.put(key, copy.data);
          patch.displayStatus = "ready";
          patch.displayKey = key;
          patch.displayBytes = copy.bytes;
        } catch (e) {
          // A bad image must not block approval; the original is still there.
          patch.displayStatus = "failed";
          patch.error = e instanceof Error ? e.message.slice(0, 300) : "display copy failed";
        }
      }
    }
    if (Object.keys(patch).length > 0) {
      await withContext({ platform: true }, (db) =>
        db.update(epodAttachmentProcessing).set({ ...patch, updatedAt: new Date() }).where(eq(epodAttachmentProcessing.attachmentId, a.id)),
      );
    }
  }

  await maybeAutoApprove(submissionId);
}

/** Policy: company has switched auto-approval on, the delivery is complete, nothing is infected, and there is a signature or 2+ photos. */
async function maybeAutoApprove(submissionId: string) {
  const [sub] = await withContext({ platform: true }, (db) => db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId)));
  if (!sub || sub.status !== "pending" || sub.outcome !== "complete") return;

  const ctxInfo = await withContext({ platform: true }, async (db) => {
    const [s] = await db.select({ on: companySettings.podAutoApprove }).from(companySettings).where(eq(companySettings.tenantId, sub.tenantId));
    const rows = await db
      .select({ kind: epodAttachments.kind, scan: epodAttachmentProcessing.scanStatus })
      .from(epodAttachments)
      .innerJoin(epodAttachmentProcessing, eq(epodAttachmentProcessing.attachmentId, epodAttachments.id))
      .where(eq(epodAttachments.submissionId, submissionId));
    return { on: s?.on ?? false, rows };
  });
  if (!ctxInfo.on) return;
  if (ctxInfo.rows.some((r) => r.scan !== "clean")) return;
  const photos = ctxInfo.rows.filter((r) => r.kind === "photo").length;
  const hasSignature = ctxInfo.rows.some((r) => r.kind === "signature");
  if (!hasSignature && photos < 2) return;

  await withTenant(sub.tenantId, null, async (db) => {
    // Lock via the submission's own trip, then re-check: a reviewer or a newer version may have got there first.
    await db.select().from(trips).where(eq(trips.id, sub.tripId)).for("update");
    const [fresh] = await db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId));
    if (fresh.status !== "pending") return;
    const [latest] = await db
      .select({ id: epodSubmissions.id })
      .from(epodSubmissions)
      .where(and(eq(epodSubmissions.stopId, sub.stopId!)))
      .orderBy(desc(epodSubmissions.version))
      .limit(1);
    if (latest.id !== submissionId) return;

    const reason = hasSignature
      ? "Approved automatically by company policy: complete delivery with receiver signature and clean files."
      : "Approved automatically by company policy: complete delivery with several photos and clean files.";
    await db.insert(podReviews).values({ tenantId: sub.tenantId, submissionId, reviewerUserId: null, automatic: true, decision: "approve", reason });
    await db.update(epodSubmissions).set({ status: "approved" }).where(eq(epodSubmissions.id, submissionId));
    await writeAudit(db, { tenantId: sub.tenantId, actorUserId: null, action: "pod.auto_approve", entityType: "epod_submission", entityId: submissionId, newValue: { reason } });
    await syncTripWithProof(db, sub.tripId, null, {}, "Proof approved automatically");
    await emitEvent(db, { type: "pod.reviewed", tenantId: sub.tenantId, tripId: sub.tripId, submissionId, decision: "approve", automatic: true, reason });
  });
}

registerJob("pod.process_submission", processSubmission as never);


// Notifications and timers register their own jobs.
import "../notify/handlers";
