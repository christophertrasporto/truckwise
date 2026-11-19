import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/server/db";
import { auditLog, epodAttachments, epodSubmissions, podReviews, tripAssignments, tripStatusEvents, trips } from "@/server/db/schema";
import { getTripForDriver, getTripForStaff } from "@/server/services/trip-detail";
import { reviewPod, submitPod as submitRaw } from "@/server/services/pod";
import { claimTrip, createOffer, declineOffer, listDriverBoard } from "@/server/services/offers";
import { advanceTrip, cancelTrip, createTrip, type TenantActor } from "@/server/services/trips";
import { storage, verifySignedRequest } from "@/server/storage";
import type { PodInput } from "@/shared/schemas/trip";
import { drain, PNG, actorFor, admin, and, customerOf, eq, extraDriver, truckIdOf, tripInput } from "../helpers";

/** Submitting queues file scanning as a background job; tests run it to completion before reviewing. */
const submitPod: typeof submitRaw = async (...args) => {
  const r = await submitRaw(...args);
  await drain();
  return r;
};

let owner: TenantActor, dispatcher: TenantActor, accountant: TenantActor, driver: TenantActor;
let bayanOwner: TenantActor, santosDriver: TenantActor;
let customerId: string;
let truck: string;

beforeAll(async () => {
  owner = await actorFor("owner@acme.test");
  dispatcher = await actorFor("dispatcher@acme.test");
  accountant = await actorFor("accountant@acme.test");
  driver = await actorFor("driver@acme.test");
  bayanOwner = await actorFor("owner@bayan.test");
  santosDriver = await actorFor("driver@santos.test");
  customerId = (await customerOf(owner.tenantId)).id;
  truck = await truckIdOf(owner.tenantId, "ACM-101");
});

afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

const newTrip = async () => (await createTrip(dispatcher, tripInput(customerId))).id;
const statusOf = async (id: string) => (await admin.db.select().from(trips).where(eq(trips.id, id)))[0].status;

async function assignedTrip(d: TenantActor = driver) {
  const id = await newTrip();
  await createOffer(dispatcher, id, { mode: "broadcast_internal" });
  await claimTrip(d, id, { truckId: truck });
  return id;
}
async function atDestination(d: TenantActor = driver) {
  const id = await assignedTrip(d);
  for (const to of ["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"] as const) await advanceTrip(d, id, to);
  return id;
}

let k = 0;
const pod = (over: Partial<PodInput> = {}): PodInput => ({
  outcome: "complete",
  receiverName: "Maria Santos",
  actualDeliveryAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  gpsConsent: "unavailable",
  idempotencyKey: `key-${Date.now()}-${k++}`,
  ...over,
});
const photo = [{ name: "receipt.png", data: PNG }];

describe("creating trips", () => {
  it("lets a dispatcher create a trip with stops, one slot, a status event and an audit row", async () => {
    const id = await newTrip();
    const detail = await getTripForStaff(dispatcher, id);
    expect(detail.trip.status).toBe("created");
    expect(detail.stops.map((s) => s.kind)).toEqual(["pickup", "delivery"]);
    expect(detail.timeline).toHaveLength(1);
    const audit = await admin.db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(audit.map((a) => a.action)).toContain("trip.create");
  });

  it("forbids drivers and rejects another company's client", async () => {
    await expect(createTrip(driver, tripInput(customerId))).rejects.toThrow(/Forbidden/);
    const foreign = await customerOf(bayanOwner.tenantId);
    await expect(createTrip(dispatcher, tripInput(foreign.id))).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a duplicate reference", async () => {
    const input = tripInput(customerId);
    await createTrip(dispatcher, input);
    await expect(createTrip(dispatcher, input)).rejects.toMatchObject({ status: 409 });
  });
});

describe("offers and visibility", () => {
  it("shows an offered trip to drivers WITHOUT the contract rate, while staff see it", async () => {
    const id = await newTrip();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    const list = await listDriverBoard(driver);
    const seen = [...list.direct, ...list.broadcast].find((t) => t.id === id)!;
    expect(seen.payoutCentavos).toBe(1_400_000);
    expect(JSON.stringify(list)).not.toMatch(/contract/i);
    expect(JSON.stringify(await getTripForDriver(driver, id))).not.toMatch(/contract|1850000/i);
    expect((await getTripForStaff(dispatcher, id)).trip.contractRateCentavos).toBe(1_850_000);
  });

  it("hides trips that were never offered to the driver (404, not 403)", async () => {
    const id = await newTrip();
    await expect(getTripForDriver(driver, id)).rejects.toMatchObject({ status: 404 });
  });

  it("only the targeted driver sees and can claim a direct offer; the other cannot", async () => {
    const other = await extraDriver(owner.tenantId);
    const id = await newTrip();
    await createOffer(dispatcher, id, { mode: "direct", driverUserId: driver.userId });
    const seenBy = async (d: TenantActor) => { const b = await listDriverBoard(d); return [...b.direct, ...b.broadcast].some((t) => t.id === id); };
    expect(await seenBy(driver)).toBe(true);
    expect(await seenBy(other)).toBe(false);
    await expect(claimTrip(other, id, { truckId: truck })).rejects.toMatchObject({ status: 409 });
    await claimTrip(driver, id, { truckId: truck });
    expect(await statusOf(id)).toBe("assigned");
  });

  it("returns the trip to 'created' when the only direct offer is declined", async () => {
    const id = await newTrip();
    await createOffer(dispatcher, id, { mode: "direct", driverUserId: driver.userId });
    await declineOffer(driver, id);
    expect(await statusOf(id)).toBe("created");
  });

  it("does not let staff roles other than dispatchers/ops offer trips, nor outsiders see them", async () => {
    const id = await newTrip();
    await expect(createOffer(accountant, id, { mode: "broadcast_internal" })).rejects.toThrow(/Forbidden/);
    await expect(getTripForStaff(bayanOwner, id)).rejects.toMatchObject({ status: 404 });
    await expect(getTripForDriver(santosDriver, id)).rejects.toThrow();
  });
});

describe("claiming (concurrency)", () => {
  it("lets exactly one of many simultaneous claimants win a single slot", async () => {
    const id = await newTrip();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    const drivers = await Promise.all(Array.from({ length: 8 }, () => extraDriver(owner.tenantId)));
    const results = await Promise.allSettled(drivers.map((d) => claimTrip(d, id, { truckId: truck })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const losers = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(losers).toHaveLength(7);
    expect(losers.every((l) => l.reason?.status === 409)).toBe(true);
    const active = await admin.db
      .select()
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, id), eq(tripAssignments.status, "active")));
    expect(active).toHaveLength(1);
    expect(await statusOf(id)).toBe("assigned");
  });

  it("the database itself refuses a second active assignment for a slot", async () => {
    const id = await assignedTrip();
    const [a] = await admin.db.select().from(tripAssignments).where(eq(tripAssignments.tripId, id));
    const other = await extraDriver(owner.tenantId);
    await expect(
      admin.db.insert(tripAssignments).values({ tenantId: a.tenantId, tripId: id, slotId: a.slotId, driverUserId: other.userId, assignedTenantId: a.tenantId }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});

describe("driver status updates", () => {
  it("walks the steps in order and records an event for each", async () => {
    const id = await atDestination();
    expect(await statusOf(id)).toBe("arrived_destination");
    const events = (await admin.db.select().from(tripStatusEvents).where(eq(tripStatusEvents.tripId, id))).sort((a, b) => a.id - b.id); // no ORDER BY in the query: sort by id
    expect(events.map((e) => e.toStatus)).toEqual([
      "created",
      "offered",
      "assigned",
      "started",
      "arrived_pickup",
      "loaded",
      "in_transit",
      "arrived_destination",
    ]);
  });

  it("rejects skipping steps and drivers who are not assigned", async () => {
    const id = await assignedTrip();
    await expect(advanceTrip(driver, id, "in_transit")).rejects.toMatchObject({ status: 409 });
    const other = await extraDriver(owner.tenantId);
    await expect(advanceTrip(other, id, "started")).rejects.toMatchObject({ status: 404 });
  });
});

describe("proof of delivery", () => {
  it("accepts proof only from the assigned driver; others get 404", async () => {
    const id = await atDestination();
    const other = await extraDriver(owner.tenantId);
    await expect(submitPod(other, id, pod(), photo)).rejects.toMatchObject({ status: 404 });
    await expect(submitPod(santosDriver, id, pod(), photo)).rejects.toThrow();
    const ok = await submitPod(driver, id, pod(), photo);
    expect(ok.version).toBe(1);
    expect(await statusOf(id)).toBe("pod_submitted");
  });

  it("keeps delivery time, server upload time and capture time distinct", async () => {
    const id = await atDestination();
    const delivered = new Date(Date.now() - 3 * 3600_000);
    const { submissionId } = await submitPod(driver, id, pod({ actualDeliveryAt: delivered.toISOString() }), photo);
    const [s] = await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId));
    expect(s.actualDeliveryAt.getTime()).toBe(delivered.getTime());
    expect(s.uploadedAt.getTime() - s.actualDeliveryAt.getTime()).toBeGreaterThan(2.9 * 3600_000);
    expect(s.actualDeliverySource).toBe("driver_entered");
    expect(s.deliveryVerification).toBe("unverified");
    const [file] = await admin.db.select().from(epodAttachments).where(eq(epodAttachments.submissionId, submissionId));
    expect(file.capturedAt).toBeNull();
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.objectKey.startsWith(`tenants/${owner.tenantId}/trips/${id}/pod/`)).toBe(true);
  });

  it("rejects future delivery times, non-images (by content, not name) and missing photos", async () => {
    const id = await atDestination();
    await expect(submitPod(driver, id, pod({ actualDeliveryAt: new Date(Date.now() + 3600_000).toISOString() }), photo)).rejects.toMatchObject({ status: 400 });
    await expect(submitPod(driver, id, pod(), [{ name: "evil.jpg", data: Buffer.from("<script>alert(1)</script>") }])).rejects.toMatchObject({ status: 400 });
    await expect(submitPod(driver, id, pod(), [])).rejects.toMatchObject({ status: 400 });
    expect(await statusOf(id)).toBe("arrived_destination");
  });

  it("is idempotent: retrying with the same key does not create a second version", async () => {
    const id = await atDestination();
    const input = pod();
    const a = await submitPod(driver, id, input, photo);
    const b = await submitPod(driver, id, input, photo);
    expect(b.duplicate).toBe(true);
    expect(b.submissionId).toBe(a.submissionId);
    expect(await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.tripId, id))).toHaveLength(1);
  });

  it("records both identities when dispatch submits on the driver's behalf", async () => {
    const id = await atDestination();
    const { submissionId } = await submitPod(dispatcher, id, pod(), photo);
    const [s] = await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId));
    expect(s.recordedBy).toBe(dispatcher.userId);
    expect(s.onBehalfOfUserId).toBe(driver.userId);
    expect(s.driverUserId).toBe(driver.userId);
  });

  it("refuses proof before the trip has arrived", async () => {
    const id = await assignedTrip();
    await expect(submitPod(driver, id, pod(), photo)).rejects.toMatchObject({ status: 409 });
  });

  it("stores GPS only when consent was granted", async () => {
    const id = await atDestination();
    const { submissionId } = await submitPod(driver, id, pod({ gpsConsent: "denied", gpsLat: 14.5, gpsLng: 121 }), photo);
    const [s] = await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.id, submissionId));
    expect(s.gpsConsent).toBe("denied");
    expect(s.gpsLat).toBeNull();
  });

  it("routes partial/damaged/failed deliveries to delivery_exception", async () => {
    const id = await atDestination();
    await submitPod(driver, id, pod({ outcome: "partial", discrepancyNotes: "3 pallets short" }), photo);
    expect(await statusOf(id)).toBe("delivery_exception");
  });
});

describe("dispatcher review", () => {
  it("approve -> ready_for_invoice, with reviewer, decision and audit recorded", async () => {
    const id = await atDestination();
    const { submissionId } = await submitPod(driver, id, pod(), photo);
    await reviewPod(dispatcher, submissionId, { decision: "approve" });
    expect(await statusOf(id)).toBe("ready_for_invoice");
    const [r] = await admin.db.select().from(podReviews).where(eq(podReviews.submissionId, submissionId));
    expect(r).toMatchObject({ decision: "approve", reviewerUserId: dispatcher.userId });
    const audit = await admin.db.select().from(auditLog).where(eq(auditLog.entityId, submissionId));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["pod.submit", "pod.approve"]));
  });

  it("reject keeps v1, sends the trip back, and a resubmission becomes v2 which can then be approved", async () => {
    const id = await atDestination();
    const v1 = await submitPod(driver, id, pod(), photo);
    await expect(reviewPod(dispatcher, v1.submissionId, { decision: "reject" })).rejects.toMatchObject({ status: 400 });
    await reviewPod(dispatcher, v1.submissionId, { decision: "reject", reason: "Photo is blurry" });
    expect(await statusOf(id)).toBe("arrived_destination");
    const v2 = await submitPod(driver, id, pod(), photo);
    expect(v2.version).toBe(2);
    await reviewPod(dispatcher, v2.submissionId, { decision: "approve" });
    const rows = await admin.db.select().from(epodSubmissions).where(eq(epodSubmissions.tripId, id));
    expect(rows.map((r) => [r.version, r.status]).sort()).toEqual([[1, "rejected"], [2, "approved"]]);
    const files = await admin.db.select().from(epodAttachments).where(eq(epodAttachments.submissionId, v1.submissionId));
    expect(files).toHaveLength(1); // earlier evidence is still there
    expect(await statusOf(id)).toBe("ready_for_invoice");
  });

  it("requires a reason to accept an exception, and a reviewed proof cannot be reviewed twice", async () => {
    const id = await atDestination();
    const { submissionId } = await submitPod(driver, id, pod({ outcome: "discrepancy", discrepancyNotes: "2 cartons damaged" }), photo);
    await expect(reviewPod(dispatcher, submissionId, { decision: "approve" })).rejects.toMatchObject({ status: 400 });
    await reviewPod(dispatcher, submissionId, { decision: "approve", reason: "Customer accepted the damage" });
    await expect(reviewPod(dispatcher, submissionId, { decision: "reject", reason: "x" })).rejects.toMatchObject({ status: 409 });
  });

  it("forbids drivers and other companies from reviewing", async () => {
    const id = await atDestination();
    const { submissionId } = await submitPod(driver, id, pod(), photo);
    await expect(reviewPod(driver, submissionId, { decision: "approve" })).rejects.toThrow(/Forbidden/);
    await expect(reviewPod(bayanOwner, submissionId, { decision: "approve" })).rejects.toMatchObject({ status: 404 });
  });

  it("shows staff the proof with short-lived signed photo URLs, and the driver only their own", async () => {
    const id = await atDestination();
    await submitPod(driver, id, pod(), photo);
    const staff = await getTripForStaff(dispatcher, id);
    const url = new URL(staff.proof[0].photos[0].url!, "http://x");
    const key = decodeURIComponent(url.pathname.replace("/api/files/", ""));
    expect(verifySignedRequest(key, Number(url.searchParams.get("exp")), url.searchParams.get("sig")!)).toBe(true);
    expect(verifySignedRequest(key, Number(url.searchParams.get("exp")), "0".repeat(64))).toBe(false);
    expect(verifySignedRequest(key, Math.floor(Date.now() / 1000) - 10, url.searchParams.get("sig")!)).toBe(false);
    expect((await storage.get(key)).equals(PNG)).toBe(true);
    const mine = await getTripForDriver(driver, id);
    expect(mine.proof).toHaveLength(1);
    await expect(getTripForDriver(await extraDriver(owner.tenantId), id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("evidence is immutable", () => {
  it("the app role cannot edit or delete proof, reviews or status history", async () => {
    const id = await atDestination();
    const { submissionId } = await submitPod(driver, id, pod(), photo);
    await reviewPod(dispatcher, submissionId, { decision: "approve" });
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.update(epodSubmissions).set({ receiverName: "Forged" }))).rejects.toThrow();
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.delete(epodSubmissions))).rejects.toThrow();
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.update(podReviews).set({ reason: "x" }))).rejects.toThrow();
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.delete(tripStatusEvents))).rejects.toThrow();
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.delete(epodAttachments))).rejects.toThrow();
  });

  it("even the table owner cannot alter submitted evidence (trigger)", async () => {
    const id = await atDestination();
    const { submissionId } = await submitPod(driver, id, pod(), photo);
    await expect(admin.db.update(epodSubmissions).set({ receiverName: "Forged" }).where(eq(epodSubmissions.id, submissionId))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/immutable/) },
    });
  });
});

describe("cancelling", () => {
  it("cancels an offered trip and withdraws its offers", async () => {
    const id = await newTrip();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await cancelTrip(dispatcher, id);
    expect(await statusOf(id)).toBe("cancelled");
    { const b = await listDriverBoard(driver); expect([...b.direct, ...b.broadcast].some((t) => t.id === id)).toBe(false); }
    await expect(claimTrip(driver, id, { truckId: truck })).rejects.toMatchObject({ status: 409 });
  });
});
