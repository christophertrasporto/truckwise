import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/server/db";
import { driverProfiles, tripApplications, tripAssignments, tripOffers, trips, trucks } from "@/server/db/schema";
import { calendarForStaff } from "@/server/services/calendar";
import { addTruck, truckPatch, updateTruck, upsertDriverProfile } from "@/server/services/fleet";
import { addMember } from "@/server/services/members";
import {
  cancelOffer,
  claimTrip,
  createOffer,
  decideApplication,
  declineOffer,
  listDriverBoard,
  reassignTrip,
  sweepExpiredOffers,
  withdrawApplication,
} from "@/server/services/offers";
import { getTripForPartner, listPartnerBoard, listPartnerWork, partnerAccept, partnerDecline, partnerOptions } from "@/server/services/partner";
import { inviteSubcontractor, setPartnerStatus } from "@/server/services/partners";
import { reviewPod, submitPod as submitRaw } from "@/server/services/pod";
import { updateSettings } from "@/server/services/settings";
import { getTripForDriver, getTripForStaff } from "@/server/services/trip-detail";
import { advanceTrip, createTrip, type TenantActor } from "@/server/services/trips";
import type { OfferInput, PodInput } from "@/shared/schemas/trip";
import { drain, PNG, actorFor, admin, customerOf, eq, extraDriver, truckIdOf, tripInput } from "../helpers";

/** Submitting queues file scanning as a background job; tests run it to completion before reviewing. */
const submitPod: typeof submitRaw = async (...args) => {
  const r = await submitRaw(...args);
  await drain();
  return r;
};

let owner: TenantActor, dispatcher: TenantActor, accountant: TenantActor, driver: TenantActor;
let partnerOwner: TenantActor, partnerDriver: TenantActor, bayanOwner: TenantActor;
let customerId: string, acmeTruck: string, acmeVan: string, partnerBig: string, partnerSmall: string;

beforeAll(async () => {
  owner = await actorFor("owner@acme.test");
  dispatcher = await actorFor("dispatcher@acme.test");
  accountant = await actorFor("accountant@acme.test");
  driver = await actorFor("driver@acme.test");
  partnerOwner = await actorFor("owner@santos.test");
  partnerDriver = await actorFor("driver@santos.test");
  bayanOwner = await actorFor("owner@bayan.test");
  customerId = (await customerOf(owner.tenantId)).id;
  acmeTruck = await truckIdOf(owner.tenantId, "ACM-101");
  acmeVan = await truckIdOf(owner.tenantId, "ACM-102");
  partnerBig = await truckIdOf(partnerOwner.tenantId, "STS-201");
  partnerSmall = await truckIdOf(partnerOwner.tenantId, "STS-202");
});

beforeEach(async () => {
  await updateSettings(owner, { claimMode: "immediate" });
});

afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
const mk = async (over: Parameters<typeof tripInput>[1] = {}) => (await createTrip(dispatcher, tripInput(customerId, over))).id;
const offer = (id: string, o: OfferInput) => createOffer(dispatcher, id, o);
const statusOf = async (id: string) => (await admin.db.select().from(trips).where(eq(trips.id, id)))[0].status;
const boardIds = async (d: TenantActor) => {
  const b = await listDriverBoard(d);
  return [...b.direct, ...b.broadcast].map((t) => t.id);
};
const partnerIds = async (a: TenantActor = partnerOwner) => {
  const b = await listPartnerBoard(a);
  return [...b.direct, ...b.broadcast].map((t) => t.id);
};
const haulerOfPartner = () => owner.tenantId;
const pod = (over: Partial<PodInput> = {}): PodInput => ({
  outcome: "complete",
  receiverName: "R. Cruz",
  actualDeliveryAt: new Date(Date.now() - 600_000).toISOString(),
  gpsConsent: "unavailable",
  idempotencyKey: `k-${Math.random().toString(36).slice(2)}-${Date.now()}`,
  ...over,
});

describe("who sees which offer", () => {
  it("broadcast_internal: our drivers yes, subcontractors no", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_internal" });
    expect(await boardIds(driver)).toContain(id);
    expect(await partnerIds()).not.toContain(id);
  });

  it("broadcast_partners: approved subcontractors yes, our drivers no", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_partners" });
    expect(await partnerIds()).toContain(id);
    expect(await boardIds(driver)).not.toContain(id);
  });

  it("broadcast_all reaches both", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_all" });
    expect(await partnerIds()).toContain(id);
    expect(await boardIds(driver)).toContain(id);
  });

  it("selected: only the chosen drivers", async () => {
    const other = await extraDriver(owner.tenantId);
    const id = await mk();
    await offer(id, { mode: "selected", userIds: [other.userId] });
    expect(await boardIds(other)).toContain(id);
    expect(await boardIds(driver)).not.toContain(id);
    expect(await partnerIds()).not.toContain(id);
  });

  it("direct to a subcontractor company: only that company, and it can decline", async () => {
    const id = await mk();
    await offer(id, { mode: "direct", partnerTenantId: partnerOwner.tenantId });
    expect(await partnerIds()).toContain(id);
    expect(await boardIds(driver)).not.toContain(id);
    await partnerDecline(partnerOwner, haulerOfPartner(), id);
    expect(await statusOf(id)).toBe("created");
    expect(await partnerIds()).not.toContain(id);
  });

  it("direct offers show up under 'direct', broadcast under 'broadcast'", async () => {
    const a = await mk();
    const b = await mk();
    await offer(a, { mode: "direct", driverUserId: driver.userId });
    await offer(b, { mode: "broadcast_internal" });
    const board = await listDriverBoard(driver);
    expect(board.direct.map((t) => t.id)).toContain(a);
    expect(board.broadcast.map((t) => t.id)).toContain(b);
    expect(board.direct.map((t) => t.id)).not.toContain(b);
  });

  it("rejects offering to people who are not eligible recipients", async () => {
    const id = await mk();
    await expect(offer(id, { mode: "direct", driverUserId: accountant.userId })).rejects.toMatchObject({ status: 400 });
    await expect(offer(id, { mode: "direct", partnerTenantId: bayanOwner.tenantId })).rejects.toMatchObject({ status: 400 });
    await expect(createOffer(dispatcher, id, { mode: "broadcast_internal", expiresAt: at(-1) })).rejects.toMatchObject({ status: 400 });
  });
});

describe("accepting: immediate vs approval", () => {
  it("approval_required: accepting only sends a request, then dispatch approves it", async () => {
    await updateSettings(owner, { claimMode: "approval_required" });
    const id = await mk();
    await offer(id, { mode: "broadcast_internal" });
    expect(await claimTrip(driver, id, { truckId: acmeTruck })).toEqual({ status: "pending" });
    expect(await statusOf(id)).toBe("offered");
    const detail = await getTripForStaff(dispatcher, id);
    expect(detail.applications).toHaveLength(1);
    await decideApplication(dispatcher, detail.applications[0].id, { decision: "approve" });
    expect(await statusOf(id)).toBe("assigned");
    expect((await getTripForStaff(dispatcher, id)).driver?.name).toBe("Acme Driver");
  });

  it("dispatch can decline a request, and the driver can withdraw one", async () => {
    await updateSettings(owner, { claimMode: "approval_required" });
    const other = await extraDriver(owner.tenantId);
    const id = await mk();
    await offer(id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    await claimTrip(other, id, { truckId: acmeVan });
    await withdrawApplication(other, id);
    const apps = (await getTripForStaff(dispatcher, id)).applications;
    expect(apps.find((a) => a.applicantName === "Acme Driver")!.status).toBe("pending");
    await decideApplication(dispatcher, apps.find((a) => a.applicantName === "Acme Driver")!.id, { decision: "decline", reason: "Closer driver available" });
    expect(await statusOf(id)).toBe("offered");
    await expect(withdrawApplication(other, id)).rejects.toMatchObject({ status: 404 });
  });

  it("applicants call: even with immediate acceptance, dispatch picks one of several applicants", async () => {
    const other = await extraDriver(owner.tenantId);
    const id = await mk();
    await offer(id, { mode: "applicants", audience: "internal" });
    expect(await claimTrip(driver, id, { truckId: acmeTruck })).toEqual({ status: "pending" });
    expect(await claimTrip(other, id, { truckId: acmeVan })).toEqual({ status: "pending" });
    expect(await statusOf(id)).toBe("offered");
    const apps = (await getTripForStaff(dispatcher, id)).applications;
    expect(apps).toHaveLength(2);
    const chosen = apps.find((a) => a.applicantName !== "Acme Driver")!;
    await decideApplication(dispatcher, chosen.id, { decision: "approve" });
    const after = await getTripForStaff(dispatcher, id);
    expect(after.driver?.name).toBe(chosen.applicantName);
    expect(after.applications.filter((a) => a.status === "pending")).toHaveLength(0);
    expect(after.applications.find((a) => a.id !== chosen.id)!.status).toBe("declined");
  });

  it("an application cannot be approved twice, and needs the right role", async () => {
    await updateSettings(owner, { claimMode: "approval_required" });
    const id = await mk();
    await offer(id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    const appId = (await getTripForStaff(dispatcher, id)).applications[0].id;
    await expect(decideApplication(accountant, appId, { decision: "approve" })).rejects.toThrow(/Forbidden/);
    await decideApplication(dispatcher, appId, { decision: "approve" });
    await expect(decideApplication(dispatcher, appId, { decision: "approve" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("eligibility", () => {
  it("rejects an expired driver license with a plain reason", async () => {
    const d = await extraDriver(owner.tenantId);
    await admin.db.update(driverProfiles).set({ licenseExpiry: "2020-01-01" }).where(eq(driverProfiles.userId, d.userId));
    const id = await mk();
    await offer(id, { mode: "broadcast_internal" });
    await expect(claimTrip(d, id, { truckId: acmeTruck })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/license/i) });
    const row = (await listDriverBoard(d)).broadcast.find((t) => t.id === id)!;
    expect(row.issues.join(" ")).toMatch(/license/i);
  });

  it("rejects the wrong truck type, too little capacity, and trucks not in service", async () => {
    const id = await mk({ truckRequirement: "10-wheeler", weightKg: 8000 });
    await offer(id, { mode: "broadcast_internal" });
    await expect(claimTrip(driver, id, { truckId: acmeVan })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/needs a 10-wheeler/) });
    await updateTruck(owner, acmeTruck, { status: "maintenance" });
    await expect(claimTrip(driver, id, { truckId: acmeTruck })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/maintenance/) });
    await updateTruck(owner, acmeTruck, { status: "active" });
    const heavy = await mk({ weightKg: 20000 });
    await offer(heavy, { mode: "broadcast_internal" });
    await expect(claimTrip(driver, heavy, { truckId: acmeTruck })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/carries 12000 kg/) });
  });

  it("rejects a truck whose registration expires before the job ends", async () => {
    const stale = (await addTruck(owner, { plate: `OLD-${Date.now() % 100000}`, truckType: "10-wheeler", capacityKg: 9000, registrationExpiry: "2020-01-01", inspectionExpiry: "2099-01-01" })).id;
    const id = await mk({ stops: [{ kind: "pickup", address: "A street", requiredArrivalAt: at(24) }, { kind: "delivery", address: "B street", requiredArrivalAt: at(30) }] });
    await offer(id, { mode: "broadcast_internal" });
    await expect(claimTrip(driver, id, { truckId: stale })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/registration/) });
  });

  it("blocks a driver and a truck that are already on an overlapping trip, but allows a different day", async () => {
    const stops = (h: number) => [
      { kind: "pickup" as const, address: "Batangas Port", requiredArrivalAt: at(h) },
      { kind: "delivery" as const, address: "Makati City", requiredArrivalAt: at(h + 4) },
    ];
    const first = await mk({ stops: stops(200) });
    await offer(first, { mode: "broadcast_internal" });
    await claimTrip(driver, first, { truckId: acmeTruck });

    const overlapping = await mk({ stops: stops(202) });
    await offer(overlapping, { mode: "broadcast_internal" });
    await expect(claimTrip(driver, overlapping, { truckId: acmeTruck })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/driver is already on another trip/) });
    const other = await extraDriver(owner.tenantId);
    await expect(claimTrip(other, overlapping, { truckId: acmeTruck })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/truck is already on another trip/) });
    await claimTrip(other, overlapping, { truckId: acmeVan }); // different truck and driver is fine

    const nextDay = await mk({ stops: stops(260) });
    await offer(nextDay, { mode: "broadcast_internal" });
    await claimTrip(driver, nextDay, { truckId: acmeTruck });
  });

  it("an unscheduled trip never conflicts", async () => {
    const a = await mk();
    const b = await mk();
    await offer(a, { mode: "broadcast_internal" });
    await offer(b, { mode: "broadcast_internal" });
    const d = await extraDriver(owner.tenantId);
    await claimTrip(d, a, { truckId: acmeTruck });
    await claimTrip(d, b, { truckId: acmeTruck });
  });
});

describe("timeouts, cancelling, reassigning", () => {
  it("expires an overdue offer, returns the trip to created and refuses late acceptance", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_internal", expiresAt: at(1) });
    await admin.db.update(tripOffers).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(tripOffers.tripId, id));
    // Reading the board already runs the sweep; either way an overdue offer is never actionable.
    expect(await boardIds(driver)).not.toContain(id);
    await expect(claimTrip(driver, id, { truckId: acmeTruck })).rejects.toMatchObject({ status: 409 });
    await sweepExpiredOffers(owner.tenantId); // idempotent: safe to run again
    expect(await statusOf(id)).toBe("created");
    expect((await getTripForStaff(dispatcher, id)).offers[0].status).toBe("expired");
  });

  it("expires pending requests together with their offer", async () => {
    await updateSettings(owner, { claimMode: "approval_required" });
    const id = await mk();
    await offer(id, { mode: "broadcast_internal", expiresAt: at(1) });
    await claimTrip(driver, id, { truckId: acmeTruck });
    await admin.db.update(tripOffers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tripOffers.tripId, id));
    await sweepExpiredOffers(owner.tenantId);
    const apps = await admin.db.select().from(tripApplications).where(eq(tripApplications.tripId, id));
    expect(apps.map((a) => a.status)).toEqual(["expired"]);
    expect(await statusOf(id)).toBe("created");
  });

  it("cancelling an offer withdraws it and declines pending requests", async () => {
    await updateSettings(owner, { claimMode: "approval_required" });
    const id = await mk();
    const { offerId } = await offer(id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    await cancelOffer(dispatcher, offerId);
    expect(await statusOf(id)).toBe("created");
    const apps = await admin.db.select().from(tripApplications).where(eq(tripApplications.tripId, id));
    expect(apps[0].status).toBe("declined");
    await expect(cancelOffer(dispatcher, offerId)).rejects.toMatchObject({ status: 409 });
  });

  it("a declined direct offer goes back to dispatch", async () => {
    const id = await mk();
    await offer(id, { mode: "direct", driverUserId: driver.userId });
    await declineOffer(driver, id);
    expect(await statusOf(id)).toBe("created");
  });

  it("reassigns before loading: releases the driver, keeps history, lets dispatch offer again", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    await advanceTrip(driver, id, "started");
    await expect(reassignTrip(accountant, id, "x".repeat(5))).rejects.toThrow(/Forbidden/);
    await reassignTrip(dispatcher, id, "Driver called in sick");
    expect(await statusOf(id)).toBe("created");
    const all = await admin.db.select().from(tripAssignments).where(eq(tripAssignments.tripId, id));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "released", releasedReason: "Driver called in sick", releasedBy: dispatcher.userId });
    await expect(advanceTrip(driver, id, "arrived_pickup")).rejects.toMatchObject({ status: 404 });
    const replacement = await extraDriver(owner.tenantId);
    await offer(id, { mode: "direct", driverUserId: replacement.userId });
    await claimTrip(replacement, id, { truckId: acmeVan });
    expect(await statusOf(id)).toBe("assigned");
    const timeline = (await getTripForStaff(dispatcher, id)).timeline.map((t) => t.note ?? "");
    expect(timeline.some((n) => n.includes("Reassigned: Driver called in sick"))).toBe(true);
  });

  it("cannot reassign once cargo is loaded", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    for (const s of ["started", "arrived_pickup", "loaded"] as const) await advanceTrip(driver, id, s);
    await expect(reassignTrip(dispatcher, id, "too late now")).rejects.toMatchObject({ status: 409 });
  });
});

describe("subcontractor portal", () => {
  it("accepts with an approved truck and its own driver, then the driver completes the trip and dispatch approves", async () => {
    const id = await mk({ truckRequirement: "10-wheeler", weightKg: 9000 });
    await offer(id, { mode: "broadcast_partners" });

    // The accept form lists every truck/driver with the reasons it would be refused.
    const options = await partnerOptions(partnerOwner, haulerOfPartner(), id);
    expect(options.trucks.find((t) => t.id === partnerBig)!.reasons).toEqual([]);
    expect(options.trucks.find((t) => t.id === partnerSmall)!.reasons.join(" ")).toMatch(/needs a 10-wheeler/);
    await expect(partnerAccept(partnerOwner, haulerOfPartner(), id, { truckId: partnerSmall, driverUserId: partnerDriver.userId })).rejects.toMatchObject({ status: 422 });

    expect(await partnerAccept(partnerOwner, haulerOfPartner(), id, { truckId: partnerBig, driverUserId: partnerDriver.userId })).toEqual({ status: "assigned" });
    const staff = await getTripForStaff(dispatcher, id);
    expect(staff.driver).toMatchObject({ name: "Santos Driver", company: "Santos Trucking (Subcontractor)", external: true, truckPlate: "STS-201" });
    expect((await listPartnerWork(partnerOwner)).assigned.map((t) => t.id)).toContain(id);

    // The partner's own driver runs the trip and sees no money at all.
    const view = await getTripForDriver(partnerDriver, id);
    expect(JSON.stringify(view)).not.toMatch(/payout|contract|1850000|1400000/i);
    expect(view.assignedToMe).toBe(true);
    for (const s of ["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"] as const) await advanceTrip(partnerDriver, id, s);
    const { submissionId } = await submitPod(partnerDriver, id, pod(), [{ name: "receipt.png", data: PNG }]);
    const detail = await getTripForStaff(dispatcher, id);
    expect(String(detail.proof[0].photos[0].url)).toContain(`tenants%2F${owner.tenantId}`.replace("%2F", "/"));
    await reviewPod(dispatcher, submissionId, { decision: "approve" });
    expect(await statusOf(id)).toBe("ready_for_invoice");
  });

  it("the partner owner sees the payout offered to their company, but never the contract rate", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_partners" });
    const board = await listPartnerBoard(partnerOwner);
    const row = [...board.direct, ...board.broadcast].find((t) => t.id === id)!;
    expect(row.payoutCentavos).toBe(1_400_000);
    expect(JSON.stringify(board)).not.toMatch(/contract/i);
    expect(JSON.stringify(await getTripForPartner(partnerOwner, haulerOfPartner(), id))).not.toMatch(/contract|1850000/i);
  });

  it("follows the hauler's approval setting (request first, dispatch approves)", async () => {
    await updateSettings(owner, { claimMode: "approval_required" });
    const id = await mk();
    await offer(id, { mode: "broadcast_partners" });
    expect(await partnerAccept(partnerOwner, haulerOfPartner(), id, { truckId: partnerBig, driverUserId: partnerDriver.userId })).toEqual({ status: "pending" });
    expect((await listPartnerWork(partnerOwner)).pending.map((t) => t.id)).toContain(id);
    const app = (await getTripForStaff(dispatcher, id)).applications[0];
    expect(app).toMatchObject({ external: true, truckPlate: "STS-201", companyName: "Santos Trucking (Subcontractor)" });
    await decideApplication(dispatcher, app.id, { decision: "approve" });
    expect((await getTripForStaff(dispatcher, id)).driver?.external).toBe(true);
  });

  it("a partner cannot use a driver or truck from another company, and only partner roles may accept", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_partners" });
    await expect(partnerAccept(partnerOwner, haulerOfPartner(), id, { truckId: acmeTruck, driverUserId: partnerDriver.userId })).rejects.toMatchObject({ status: 400 });
    await expect(partnerAccept(partnerOwner, haulerOfPartner(), id, { truckId: partnerBig, driverUserId: driver.userId })).rejects.toMatchObject({ status: 400 });
    await expect(partnerAccept(partnerDriver, haulerOfPartner(), id, { truckId: partnerBig, driverUserId: partnerDriver.userId })).rejects.toThrow(/Forbidden/);
    await expect(partnerAccept(dispatcher, haulerOfPartner(), id, { truckId: partnerBig, driverUserId: partnerDriver.userId })).rejects.toThrow(/Forbidden/);
  });

  it("is isolated: no trips from other haulers, unoffered trips, or without an approval", async () => {
    const internalOnly = await mk();
    await offer(internalOnly, { mode: "broadcast_internal" });
    const unoffered = await mk();
    await expect(getTripForPartner(partnerOwner, haulerOfPartner(), internalOnly)).rejects.toMatchObject({ status: 404 });
    await expect(getTripForPartner(partnerOwner, haulerOfPartner(), unoffered)).rejects.toMatchObject({ status: 404 });
    await expect(partnerAccept(partnerOwner, haulerOfPartner(), internalOnly, { truckId: partnerBig, driverUserId: partnerDriver.userId })).rejects.toMatchObject({ status: 409 });
    await expect(partnerAccept(partnerOwner, bayanOwner.tenantId, internalOnly, { truckId: partnerBig, driverUserId: partnerDriver.userId })).rejects.toMatchObject({ status: 404 });
    // At the database level a partner's own context cannot read the hauler's trips at all.
    expect(await withTenant(partnerOwner.tenantId, partnerOwner.userId, (db) => db.select().from(trips))).toEqual([]);
    expect(await withTenant(partnerOwner.tenantId, partnerOwner.userId, (db) => db.select().from(tripOffers))).toEqual([]);
  });

  it("revoking approval stops new offers but lets assigned trips finish", async () => {
    const live = await mk();
    await offer(live, { mode: "broadcast_partners" });
    await partnerAccept(partnerOwner, haulerOfPartner(), live, { truckId: partnerBig, driverUserId: partnerDriver.userId });
    const open = await mk();
    await offer(open, { mode: "broadcast_partners" });
    await setPartnerStatus(owner, partnerOwner.tenantId, "revoked");
    try {
      expect(await partnerIds()).not.toContain(open);
      await expect(partnerAccept(partnerOwner, haulerOfPartner(), open, { truckId: partnerBig, driverUserId: partnerDriver.userId })).rejects.toMatchObject({ status: 404 });
      await advanceTrip(partnerDriver, live, "started"); // existing job continues
    } finally {
      await setPartnerStatus(owner, partnerOwner.tenantId, "approved");
    }
  });

  it("a partner driver cannot touch trips assigned to someone else", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    await expect(getTripForDriver(partnerDriver, id)).rejects.toMatchObject({ status: 404 });
    await expect(advanceTrip(partnerDriver, id, "started")).rejects.toMatchObject({ status: 404 });
  });

  it("an internal driver and a subcontractor racing for the same trip: exactly one wins", async () => {
    const id = await mk();
    await offer(id, { mode: "broadcast_all" });
    const results = await Promise.allSettled([
      claimTrip(driver, id, { truckId: acmeTruck }),
      partnerAccept(partnerOwner, haulerOfPartner(), id, { truckId: partnerBig, driverUserId: partnerDriver.userId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const active = await admin.db.select().from(tripAssignments).where(eq(tripAssignments.tripId, id));
    expect(active.filter((a) => a.status === "active")).toHaveLength(1);
  });
});

describe("available-trips board filters", () => {
  it("filters by location, date range, truck type and minimum payout", async () => {
    const day = (h: number) => at(h);
    const near = await mk({ payoutCentavos: 900_000, truckRequirement: "6-wheeler", stops: [{ kind: "pickup", address: "Cebu Pier 3", requiredArrivalAt: day(300) }, { kind: "delivery", address: "Mandaue", requiredArrivalAt: day(306) }] });
    const far = await mk({ payoutCentavos: 2_500_000, truckRequirement: "10-wheeler", stops: [{ kind: "pickup", address: "Davao Port", requiredArrivalAt: day(600) }, { kind: "delivery", address: "Gensan", requiredArrivalAt: day(606) }] });
    await offer(near, { mode: "broadcast_internal" });
    await offer(far, { mode: "broadcast_internal" });
    const ids = async (f: Parameters<typeof listDriverBoard>[1]) => {
      const b = await listDriverBoard(driver, f);
      return [...b.direct, ...b.broadcast].map((t) => t.id);
    };
    expect(await ids({ location: "cebu" })).toEqual([near]);
    expect(await ids({ location: "gensan" })).toEqual([far]);
    expect(await ids({ truckType: "10-wheeler" })).toEqual(expect.arrayContaining([far]));
    expect(await ids({ truckType: "10-wheeler" })).not.toContain(near);
    expect(await ids({ minPayoutCentavos: 2_000_000 })).toEqual(expect.arrayContaining([far]));
    expect(await ids({ minPayoutCentavos: 2_000_000 })).not.toContain(near);
    const nearDay = new Date(Date.parse(day(300)) + 8 * 3600_000).toISOString().slice(0, 10);
    expect(await ids({ from: nearDay, to: nearDay })).toEqual([near]);
    expect(await ids({ location: "nowhere" })).toEqual([]);
  });
});

describe("dispatch calendar", () => {
  it("lists scheduled trips inside the range and keeps unscheduled ones separate", async () => {
    const soon = await mk({ stops: [{ kind: "pickup", address: "Pier", requiredArrivalAt: at(30) }, { kind: "delivery", address: "Depot", requiredArrivalAt: at(36) }] });
    const later = await mk({ stops: [{ kind: "pickup", address: "Pier", requiredArrivalAt: at(24 * 40) }, { kind: "delivery", address: "Depot", requiredArrivalAt: at(24 * 40 + 6) }] });
    const open = await mk();
    const from = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const cal = await calendarForStaff(dispatcher, from, 7);
    expect(cal.scheduled.map((e) => e.id)).toContain(soon);
    expect(cal.scheduled.map((e) => e.id)).not.toContain(later);
    expect(cal.unscheduled.map((e) => e.id)).toContain(open);
    await expect(calendarForStaff(driver, from, 7)).rejects.toThrow(/Forbidden/);
  });
});

describe("fleet and subcontractor management", () => {
  it("only fleet managers add trucks; plates are unique; other companies cannot edit them", async () => {
    const plate = `NEW-${Date.now() % 100000}`;
    await expect(addTruck(dispatcher, { plate, truckType: "Wing van", capacityKg: 8000 })).rejects.toThrow(/Forbidden/);
    const { id } = await addTruck(owner, { plate, truckType: "Wing van", capacityKg: 8000, registrationExpiry: "2099-01-01", inspectionExpiry: "2099-01-01" });
    await expect(addTruck(owner, { plate, truckType: "Wing van", capacityKg: 8000 })).rejects.toMatchObject({ status: 409 });
    await expect(updateTruck(bayanOwner, id, truckPatch.parse({ status: "retired" }))).rejects.toMatchObject({ status: 404 });
    expect((await admin.db.select().from(trucks).where(eq(trucks.id, id)))[0].status).toBe("active");
  });

  it("driver license details are saved per company and only for drivers", async () => {
    const d = await extraDriver(owner.tenantId);
    await upsertDriverProfile(owner, d.userId, { licenseNumber: "N03-33-333333", licenseExpiry: "2031-05-05" });
    expect((await admin.db.select().from(driverProfiles).where(eq(driverProfiles.userId, d.userId)))[0].licenseExpiry).toBe("2031-05-05");
    await expect(upsertDriverProfile(owner, accountant.userId, { licenseNumber: "N03-33-333333", licenseExpiry: "2031-05-05" })).rejects.toMatchObject({ status: 404 });
    await expect(upsertDriverProfile(dispatcher, d.userId, { licenseNumber: "N03-33-333333", licenseExpiry: "2031-05-05" })).rejects.toThrow(/Forbidden/);
  });

  it("a partner company manages its own fleet and drivers", async () => {
    await addTruck(partnerOwner, { plate: `STS-${Date.now() % 100000}`, truckType: "Flatbed", capacityKg: 20000 });
    const email = `sub-driver-${Date.now()}@santos.test`;
    await addMember(partnerOwner, { email, name: "New Sub Driver", role: "sub_driver", password: "a-long-password-1" });
    const created = await actorFor(email);
    expect(created.role).toBe("sub_driver");
    await upsertDriverProfile(partnerOwner, created.userId, { licenseNumber: "N04-44-444444", licenseExpiry: "2040-01-01" });
  });

  it("inviting a subcontractor creates its company, owner and approval; only owners/ops may; others cannot see it", async () => {
    const input = { companyName: "Reyes Hauling", ownerName: "Ana Reyes", ownerEmail: `ana-${Date.now()}@reyes.test`, password: "a-long-password-1" };
    await expect(inviteSubcontractor(dispatcher, input)).rejects.toThrow(/Forbidden/);
    await expect(inviteSubcontractor(partnerOwner, input)).rejects.toThrow(/Forbidden/);
    const { partnerTenantId } = await inviteSubcontractor(owner, input);
    const newOwner = await actorFor(input.ownerEmail);
    expect(newOwner).toMatchObject({ role: "sub_owner", tenantKind: "subcontractor", tenantId: partnerTenantId });
    const id = await mk();
    await offer(id, { mode: "direct", partnerTenantId });
    expect(await partnerIds(newOwner)).toContain(id);
    expect(await partnerIds(partnerOwner)).not.toContain(id); // the other partner does not see a direct offer to someone else
    expect(await withTenant(bayanOwner.tenantId, bayanOwner.userId, (db) => db.select().from(trips))).not.toContainEqual(expect.objectContaining({ id }));
  });
});
