import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/server/db";
import {
  auditLog,
  epodAttachmentProcessing,
  epodAttachments,
  epodSubmissions,
  jobs,
  podReviews,
  tripStops,
  trips,
} from "@/server/db/schema";
import { enqueue, drainJobs, registerJob } from "@/server/jobs/queue";
import { withContext } from "@/server/db";
import { createOffer, claimTrip, reassignTrip } from "@/server/services/offers";
import { reviewPod, submitPod as submitRaw, type UploadedFile } from "@/server/services/pod";
import { stopProofs } from "@/server/services/proof-state";
import { updateSettings } from "@/server/services/settings";
import { getTripForStaff } from "@/server/services/trip-detail";
import { advanceTrip, createTrip, type TenantActor } from "@/server/services/trips";
import { storage } from "@/server/storage";
import type { PodInput } from "@/shared/schemas/trip";
import { PNG, actorFor, admin, customerOf, drain, eq as eqH, truckIdOf, tripInput } from "../helpers";

void eqH;

let owner: TenantActor, dispatcher: TenantActor, driver: TenantActor, bayanOwner: TenantActor;
let customerId: string, truck: string;

beforeAll(async () => {
  owner = await actorFor("owner@acme.test");
  dispatcher = await actorFor("dispatcher@acme.test");
  driver = await actorFor("driver@acme.test");
  bayanOwner = await actorFor("owner@bayan.test");
  customerId = (await customerOf(owner.tenantId)).id;
  truck = await truckIdOf(owner.tenantId, "ACM-101");
});

beforeEach(async () => {
  await updateSettings(owner, { claimMode: "immediate", podAutoApprove: false, allowPdfReceipts: false });
});

afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

const submit = async (a: TenantActor, tripId: string, input: PodInput, files: UploadedFile[]) => {
  const r = await submitRaw(a, tripId, input, files);
  await drain();
  return r;
};
let k = 0;
const pod = (over: Partial<PodInput> = {}): PodInput => ({
  outcome: "complete",
  receiverName: "R. Cruz",
  actualDeliveryAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  gpsConsent: "unavailable",
  idempotencyKey: `proof-${Date.now()}-${k++}`,
  ...over,
});
const photo: UploadedFile = { name: "receipt.png", data: PNG };
const signature: UploadedFile = { name: "sig.png", data: PNG, kind: "signature" };

const statusOf = async (id: string) => (await admin.db.select().from(trips).where(eq(trips.id, id)))[0].status;

async function twoStopTrip() {
  const id = (
    await createTrip(
      dispatcher,
      tripInput(customerId, {
        stops: [
          { kind: "pickup", address: "Batangas Port" },
          { kind: "delivery", address: "Makati warehouse" },
          { kind: "delivery", address: "Pasay warehouse" },
        ],
      }),
    )
  ).id;
  await atDestination(id);
  const stops = await admin.db.select().from(tripStops).where(and(eq(tripStops.tripId, id), eq(tripStops.kind, "delivery")));
  stops.sort((a, b) => a.seq - b.seq);
  return { id, s1: stops[0].id, s2: stops[1].id };
}
async function atDestination(id: string) {
  await createOffer(dispatcher, id, { mode: "broadcast_internal" });
  await claimTrip(driver, id, { truckId: truck });
  for (const to of ["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"] as const) await advanceTrip(driver, id, to);
}
async function singleStopTrip() {
  const id = (await createTrip(dispatcher, tripInput(customerId))).id;
  await atDestination(id);
  return id;
}

describe("trips with several delivery stops", () => {
  it("needs proof for every stop before the trip moves on; each stop is versioned and reviewed on its own", async () => {
    const { id, s1, s2 } = await twoStopTrip();
    await expect(submitRaw(driver, id, pod(), [photo])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/which delivery stop/) });

    const a = await submit(driver, id, pod({ stopId: s1 }), [photo]);
    expect(await statusOf(id)).toBe("arrived_destination"); // stop 2 still owes proof
    expect((await withTenant(owner.tenantId, owner.userId, (db) => stopProofs(db, id))).map((s) => s.state)).toEqual(["pending", "needs_proof"]);

    const b = await submit(driver, id, pod({ stopId: s2 }), [photo]);
    expect(await statusOf(id)).toBe("pod_submitted");

    await reviewPod(dispatcher, a.submissionId, { decision: "approve" });
    expect(await statusOf(id)).toBe("pod_submitted"); // stop 2 is still waiting
    await reviewPod(dispatcher, b.submissionId, { decision: "reject", reason: "Receiver name unreadable" });
    expect(await statusOf(id)).toBe("arrived_destination");

    const b2 = await submit(driver, id, pod({ stopId: s2 }), [photo]);
    expect(b2.version).toBe(2); // versions count per stop
    expect(a.version).toBe(1);
    await reviewPod(dispatcher, b2.submissionId, { decision: "approve" });
    expect(await statusOf(id)).toBe("ready_for_invoice");

    const rows = await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.tripId, id));
    expect(rows.map((r) => `${r.stopId === s1 ? 1 : 2}v${r.version}:${r.status}`).sort()).toEqual(["1v1:approved", "2v1:rejected", "2v2:approved"]);
  });

  it("refuses a second submission while one is pending or approved, and unknown or non-delivery stops", async () => {
    const { id, s1 } = await twoStopTrip();
    await submit(driver, id, pod({ stopId: s1 }), [photo]);
    await expect(submitRaw(driver, id, pod({ stopId: s1 }), [photo])).rejects.toMatchObject({ status: 409, code: "already_submitted" });
    const pickup = (await admin.db.select().from(tripStops).where(and(eq(tripStops.tripId, id), eq(tripStops.kind, "pickup"))))[0];
    await expect(submitRaw(driver, id, pod({ stopId: pickup.id }), [photo])).rejects.toMatchObject({ status: 400 });
    const other = await singleStopTrip();
    const foreignStop = (await admin.db.select().from(tripStops).where(and(eq(tripStops.tripId, other), eq(tripStops.kind, "delivery"))))[0];
    await expect(submitRaw(driver, id, pod({ stopId: foreignStop.id }), [photo])).rejects.toMatchObject({ status: 400 });
  });

  it("any stop reporting a problem makes the whole trip a delivery exception", async () => {
    const { id, s1, s2 } = await twoStopTrip();
    await submit(driver, id, pod({ stopId: s1, outcome: "partial", discrepancyNotes: "2 pallets short" }), [photo]);
    await submit(driver, id, pod({ stopId: s2 }), [photo]);
    expect(await statusOf(id)).toBe("delivery_exception");
    const detail = await getTripForStaff(dispatcher, id);
    expect(detail.stopProof.map((s) => s.state)).toEqual(["pending", "pending"]);
    // accepting the exception (with a reason) and approving the other stop completes the trip
    const subs = await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.tripId, id));
    for (const s of subs) await reviewPod(dispatcher, s.id, s.outcome === "complete" ? { decision: "approve" } : { decision: "approve", reason: "Customer accepted the shortage" });
    expect(await statusOf(id)).toBe("ready_for_invoice");
  });
});

describe("signatures and PDF receipts", () => {
  it("stores a PNG signature as a separate attachment and rejects wrong types and oversize signatures", async () => {
    const id = await singleStopTrip();
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    await expect(submitRaw(driver, id, pod(), [photo, { name: "sig.jpg", data: jpeg, kind: "signature" }])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/PNG/) });
    const big = Buffer.concat([PNG, Buffer.alloc(1.2 * 1024 * 1024)]);
    await expect(submitRaw(driver, id, pod(), [photo, { name: "sig.png", data: big, kind: "signature" }])).rejects.toMatchObject({ status: 400 });
    await expect(submitRaw(driver, id, pod(), [photo, signature, signature])).rejects.toMatchObject({ status: 400 });

    const { submissionId } = await submit(driver, id, pod(), [photo, signature]);
    const files = await admin.db.select().from(epodAttachments).where(eq(epodAttachments.submissionId, submissionId));
    expect(files.map((f) => f.kind).sort()).toEqual(["photo", "signature"]);
    const detail = await getTripForStaff(dispatcher, id);
    expect(detail.proof[0].signature?.url).toBeTruthy();
    expect(detail.proof[0].photos).toHaveLength(1);
  });

  it("accepts PDF receipts only when the company allows them, and only real PDFs", async () => {
    const id = await singleStopTrip();
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
    await expect(submitRaw(driver, id, pod(), [photo, { name: "r.pdf", data: pdf, kind: "pdf" }])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not enabled/) });
    await updateSettings(owner, { claimMode: "immediate", allowPdfReceipts: true });
    await expect(submitRaw(driver, id, pod(), [photo, { name: "fake.pdf", data: Buffer.from("just text"), kind: "pdf" }])).rejects.toMatchObject({ status: 400 });
    const { submissionId } = await submit(driver, id, pod(), [photo, { name: "r.pdf", data: pdf, kind: "pdf" }]);
    const detail = await getTripForStaff(dispatcher, id);
    expect(detail.proof[0].pdfs[0]).toMatchObject({ filename: "r.pdf", mimeType: "application/pdf", scan: "clean" });
    expect((await admin.db.select().from(epodAttachments).where(eq(epodAttachments.submissionId, submissionId))).map((f) => f.kind).sort()).toEqual(["pdf", "photo"]);
  });
});

describe("background processing: malware scan and display copies", () => {
  it("scans every file and makes a smaller display copy of photos while keeping the original untouched", async () => {
    const id = await singleStopTrip();
    const W = 2600;
    const H = 1950;
    const original = await sharp(randomBytes(W * H * 3), { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    expect(original.length).toBeLessThan(10 * 1024 * 1024); // within the upload limit
    const { submissionId } = await submitRaw(driver, id, pod(), [{ name: "big.jpg", data: original }, signature]);
    // before the job runs: pending, and approval is refused
    expect((await getTripForStaff(dispatcher, id)).proof[0].photos[0]).toMatchObject({ scan: "pending", displayUrl: null });
    await expect(reviewPod(dispatcher, submissionId, { decision: "approve" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/still being checked/) });

    await drain();
    const files = await admin.db.select({ a: epodAttachments, p: epodAttachmentProcessing }).from(epodAttachments).innerJoin(epodAttachmentProcessing, eq(epodAttachmentProcessing.attachmentId, epodAttachments.id)).where(eq(epodAttachments.submissionId, submissionId));
    const photoRow = files.find((f) => f.a.kind === "photo")!;
    const sigRow = files.find((f) => f.a.kind === "signature")!;
    expect(photoRow.p).toMatchObject({ scanStatus: "clean", displayStatus: "ready" });
    expect(photoRow.p.displayBytes!).toBeLessThan(original.length / 3);
    expect(photoRow.p.displayKey).not.toBe(photoRow.a.objectKey);
    expect(sigRow.p).toMatchObject({ scanStatus: "clean", displayStatus: "skipped" });
    expect((await storage.get(photoRow.a.objectKey)).equals(original)).toBe(true); // original kept as evidence
    const meta = await sharp(await storage.get(photoRow.p.displayKey!)).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);

    const view = (await getTripForStaff(dispatcher, id)).proof[0];
    expect(view.photos[0].displayUrl).toContain("display.jpg");
    expect(view.photos[0].url).not.toBe(view.photos[0].displayUrl);
    expect(view.signature?.displayUrl).toBeNull();
    await reviewPod(dispatcher, submissionId, { decision: "approve" });
  });

  it("quarantines an infected file: no download link, approval refused, rejection still possible", async () => {
    const id = await singleStopTrip();
    const eicar = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")]);
    const { submissionId } = await submit(driver, id, pod(), [{ name: "evil.jpg", data: eicar }]);
    const p = (await getTripForStaff(dispatcher, id)).proof[0];
    expect(p.photos[0]).toMatchObject({ scan: "infected", quarantined: true, url: null, displayUrl: null });
    await expect(reviewPod(dispatcher, submissionId, { decision: "approve" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/malware/) });
    await reviewPod(dispatcher, submissionId, { decision: "reject", reason: "File failed the security scan" });
    expect(await statusOf(id)).toBe("arrived_destination");
  });
});

describe("automatic approval policy", () => {
  const reviewOf = async (submissionId: string) => (await admin.db.select().from(podReviews).where(eq(podReviews.submissionId, submissionId)))[0];

  it("does nothing while the policy is off (the default)", async () => {
    const id = await singleStopTrip();
    const { submissionId } = await submit(driver, id, pod(), [photo, signature]);
    expect(await reviewOf(submissionId)).toBeUndefined();
    expect(await statusOf(id)).toBe("pod_submitted");
  });

  it("approves a clean, complete delivery with a signature, recording that it was the policy and not a person", async () => {
    await updateSettings(owner, { claimMode: "immediate", podAutoApprove: true });
    const id = await singleStopTrip();
    const { submissionId } = await submit(driver, id, pod(), [photo, signature]);
    const r = await reviewOf(submissionId);
    expect(r).toMatchObject({ decision: "approve", automatic: true, reviewerUserId: null });
    expect(r.reason).toMatch(/company policy/);
    expect(await statusOf(id)).toBe("ready_for_invoice");
    const audit = await admin.db.select().from(auditLog).where(eq(auditLog.entityId, submissionId));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["pod.submit", "pod.auto_approve"]));
    const shown = (await getTripForStaff(dispatcher, id)).proof[0].reviews[0];
    expect(shown.reviewerName).toMatch(/Automatic approval/);
  });

  it("also approves with two photos and no signature, but not with a single photo", async () => {
    await updateSettings(owner, { claimMode: "immediate", podAutoApprove: true });
    const two = await singleStopTrip();
    const a = await submit(driver, two, pod(), [photo, { name: "b.png", data: PNG }]);
    expect((await reviewOf(a.submissionId))?.automatic).toBe(true);
    const one = await singleStopTrip();
    const b = await submit(driver, one, pod(), [photo]);
    expect(await reviewOf(b.submissionId)).toBeUndefined();
    expect(await statusOf(one)).toBe("pod_submitted");
  });

  it("never approves exceptions or infected files automatically", async () => {
    await updateSettings(owner, { claimMode: "immediate", podAutoApprove: true });
    const partial = await singleStopTrip();
    const a = await submit(driver, partial, pod({ outcome: "partial", discrepancyNotes: "short" }), [photo, signature]);
    expect(await reviewOf(a.submissionId)).toBeUndefined();
    expect(await statusOf(partial)).toBe("delivery_exception");
    const bad = await singleStopTrip();
    const eicar = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")]);
    const b = await submit(driver, bad, pod(), [{ name: "x.jpg", data: eicar }, signature]);
    expect(await reviewOf(b.submissionId)).toBeUndefined();
  });

  it("in a multi-stop trip the trip completes only when every stop is approved", async () => {
    await updateSettings(owner, { claimMode: "immediate", podAutoApprove: true });
    const { id, s1, s2 } = await twoStopTrip();
    await submit(driver, id, pod({ stopId: s1 }), [photo, signature]);
    expect(await statusOf(id)).toBe("arrived_destination");
    await submit(driver, id, pod({ stopId: s2 }), [photo, signature]);
    expect(await statusOf(id)).toBe("ready_for_invoice");
  });
});

describe("offline submissions and timestamps", () => {
  it("records the offline path and keeps four clocks apart: delivery time, device queue time, server upload time, and capture time", async () => {
    const id = await singleStopTrip();
    const delivered = new Date(Date.now() - 5 * 3600_000);
    const queued = new Date(Date.now() - 3 * 3600_000);
    const { submissionId } = await submit(driver, id, pod({ actualDeliveryAt: delivered.toISOString(), submittedOffline: true, deviceQueuedAt: queued.toISOString() }), [photo]);
    const [s] = await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId));
    expect(s.submittedOffline).toBe(true);
    expect(s.actualDeliveryAt.getTime()).toBe(delivered.getTime());
    expect(s.deviceQueuedAt!.getTime()).toBe(queued.getTime());
    expect(s.uploadedAt.getTime()).toBeGreaterThan(queued.getTime() + 2.9 * 3600_000); // server clock, not the phone clock
    expect(s.actualDeliverySource).toBe("driver_entered");
    expect(s.deliveryVerification).toBe("unverified"); // an offline upload is never presented as verified
    const [f] = await admin.db.select().from(epodAttachments).where(eq(epodAttachments.submissionId, submissionId));
    expect(f.capturedAt).toBeNull(); // no capture time was reported, so none is invented
    const shown = (await getTripForStaff(dispatcher, id)).proof[0];
    expect(shown).toMatchObject({ submittedOffline: true });
    expect(shown.deviceQueuedAt).toBe(queued.toISOString());
    expect(shown.photos[0].capturedAt).toBeNull();
  });

  it("a normal online submission is not marked offline and carries no queue time", async () => {
    const id = await singleStopTrip();
    const { submissionId } = await submit(driver, id, pod(), [photo]);
    const [s] = await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId));
    expect(s).toMatchObject({ submittedOffline: false, deviceQueuedAt: null });
  });

  it("a retried upload (same key) returns the existing version even after it was reviewed", async () => {
    const id = await singleStopTrip();
    const input = pod({ submittedOffline: true, deviceQueuedAt: new Date().toISOString() });
    const first = await submit(driver, id, input, [photo]);
    await reviewPod(dispatcher, first.submissionId, { decision: "approve" });
    const retry = await submitRaw(driver, id, input, [photo]);
    expect(retry).toMatchObject({ duplicate: true, submissionId: first.submissionId, version: 1 });
    expect(await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.tripId, id))).toHaveLength(1);
  });
});

describe("conflicts an offline driver can run into (reported with codes, nothing overwritten)", () => {
  it("trip reassigned while offline: the old driver's upload is refused and nothing is stored", async () => {
    // Reassigning is only allowed before the cargo is loaded, so use a trip that has just been accepted.
    const early = (await createTrip(dispatcher, tripInput(customerId))).id;
    await createOffer(dispatcher, early, { mode: "broadcast_internal" });
    await claimTrip(driver, early, { truckId: truck });
    await reassignTrip(dispatcher, early, "Driver unavailable");
    await expect(submitRaw(driver, early, pod(), [photo])).rejects.toMatchObject({ status: 404 });
    expect(await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.tripId, early))).toHaveLength(0);
  });

  it("trip cancelled or not yet at the destination: conflict codes the phone can show", async () => {
    const t = (await createTrip(dispatcher, tripInput(customerId))).id;
    await createOffer(dispatcher, t, { mode: "broadcast_internal" });
    await claimTrip(driver, t, { truckId: truck });
    await expect(submitRaw(driver, t, pod(), [photo])).rejects.toMatchObject({ status: 409, code: "wrong_state" });
  });

  it("proof already reviewed while offline: a second version for an approved stop is refused", async () => {
    const id = await singleStopTrip();
    const a = await submit(driver, id, pod(), [photo]);
    await reviewPod(dispatcher, a.submissionId, { decision: "approve" });
    await expect(submitRaw(driver, id, pod(), [photo])).rejects.toMatchObject({ status: 409 });
  });
});

describe("evidence stays tenant-private", () => {
  it("other companies cannot read attachments, processing state or jobs", async () => {
    const id = await singleStopTrip();
    await submit(driver, id, pod(), [photo, signature]);
    for (const table of [epodAttachments, epodAttachmentProcessing, jobs]) {
      expect(await withTenant(bayanOwner.tenantId, bayanOwner.userId, (db) => db.select().from(table))).toEqual([]);
    }
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.update(epodAttachments).set({ kind: "photo" }))).rejects.toThrow(); // still immutable
  });
});

describe("job queue", () => {
  const countOf = (dedupeKey: string) => admin.db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey));

  it("enqueue is idempotent per dedupe key", async () => {
    registerJob("test.noop", async () => undefined);
    await withContext({ platform: true }, async (db) => {
      await enqueue(db, { tenantId: null, type: "test.noop", payload: {}, dedupeKey: "dd-1" });
      await enqueue(db, { tenantId: null, type: "test.noop", payload: {}, dedupeKey: "dd-1" });
    });
    expect(await countOf("dd-1")).toHaveLength(1);
  });

  it("retries a failing job with backoff until it succeeds", async () => {
    let calls = 0;
    registerJob("test.flaky", async () => {
      if (++calls < 3) throw new Error("boom");
    });
    await withContext({ platform: true }, (db) => enqueue(db, { tenantId: null, type: "test.flaky", payload: {}, dedupeKey: "flaky-1" }));
    for (let i = 0; i < 6; i++) {
      await drainJobs({ backoffBaseMs: 1 });
      await new Promise((r) => setTimeout(r, 15));
    }
    const [j] = await countOf("flaky-1");
    expect(j).toMatchObject({ status: "done", attempts: 3, lastError: null });
    expect(calls).toBe(3);
  });

  it("gives up after maxAttempts and keeps the last error; unknown types fail the same way", async () => {
    registerJob("test.dead", async () => {
      throw new Error("always broken");
    });
    await withContext({ platform: true }, async (db) => {
      await enqueue(db, { tenantId: null, type: "test.dead", payload: {}, dedupeKey: "dead-1", maxAttempts: 2 });
      await enqueue(db, { tenantId: null, type: "test.unregistered", payload: {}, dedupeKey: "dead-2", maxAttempts: 1 });
    });
    for (let i = 0; i < 4; i++) {
      await drainJobs({ backoffBaseMs: 1 });
      await new Promise((r) => setTimeout(r, 15));
    }
    expect((await countOf("dead-1"))[0]).toMatchObject({ status: "failed", attempts: 2, lastError: "always broken" });
    expect((await countOf("dead-2"))[0]).toMatchObject({ status: "failed" });
    expect((await countOf("dead-2"))[0].lastError).toMatch(/No handler/);
  });

  it("two workers draining at once run each job exactly once", async () => {
    let runs = 0;
    registerJob("test.once", async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
    });
    await withContext({ platform: true }, async (db) => {
      for (let i = 0; i < 6; i++) await enqueue(db, { tenantId: null, type: "test.once", payload: { i }, dedupeKey: `once-${i}` });
    });
    await Promise.all([drainJobs(), drainJobs(), drainJobs()]);
    expect(runs).toBe(6);
  });

  it("reclaims a job left 'running' by a crashed worker", async () => {
    let ran = false;
    registerJob("test.stale", async () => {
      ran = true;
    });
    await withContext({ platform: true }, (db) => enqueue(db, { tenantId: null, type: "test.stale", payload: {}, dedupeKey: "stale-1" }));
    await admin.db.update(jobs).set({ status: "running", lockedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(jobs.dedupeKey, "stale-1"));
    await drainJobs();
    expect(ran).toBe(true);
    expect((await countOf("stale-1"))[0].status).toBe("done");
  });
});
