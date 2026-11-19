import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/server/db";
import { jobs, notificationDeliveries, notifications, pushSubscriptions, tripOffers, userNotificationSettings } from "@/server/db/schema";
import { drainJobs } from "@/server/jobs/queue";
import { enqueueAutomationTick, runAutomations } from "@/server/notify/handlers";
import { setPushSender, type PushSender } from "@/server/notify/push";
import { getNotificationSettings, listNotifications, markRead, saveNotificationSettings, subscribePush, unreadCount, unsubscribePush } from "@/server/notify/service";
import { setSmsProvider, stubSent, type SmsProvider } from "@/server/notify/sms";
import { addCompanyExpense, reviewExpense, submitExpense } from "@/server/services/finance/expenses";
import { generateSettlement, markSettlementPaid } from "@/server/services/finance/settlements";
import { addMember } from "@/server/services/members";
import { cancelOffer, claimTrip, createOffer, decideApplication, declineOffer, reassignTrip } from "@/server/services/offers";
import { partnerAccept, partnerDecline } from "@/server/services/partner";
import { reviewPod, submitPod as submitRaw } from "@/server/services/pod";
import { updateSettings } from "@/server/services/settings";
import { getTripForStaff } from "@/server/services/trip-detail";
import { advanceTrip, cancelTrip, createTrip, type TenantActor } from "@/server/services/trips";
import { PNG, actorFor, admin, customerOf, drain, extraDriver, truckIdOf, tripInput } from "../helpers";

let owner: TenantActor, dispatcher: TenantActor, accountant: TenantActor, driver: TenantActor, driver2: TenantActor, ops: TenantActor;
let partnerOwner: TenantActor, partnerDriver: TenantActor, bayanOwner: TenantActor;
let customerId: string, acmeTruck: string, partnerTruck: string;
let k = 0;

beforeAll(async () => {
  owner = await actorFor("owner@acme.test");
  dispatcher = await actorFor("dispatcher@acme.test");
  accountant = await actorFor("accountant@acme.test");
  driver = await actorFor("driver@acme.test");
  driver2 = await extraDriver(owner.tenantId);
  partnerOwner = await actorFor("owner@santos.test");
  partnerDriver = await actorFor("driver@santos.test");
  bayanOwner = await actorFor("owner@bayan.test");
  const email = `ops-${Date.now()}@acme.test`;
  await addMember(owner, { email, name: "Ops Manager", role: "ops_manager", password: "a-long-password-1" });
  ops = await actorFor(email);
  customerId = (await customerOf(owner.tenantId)).id;
  acmeTruck = await truckIdOf(owner.tenantId, "ACM-101");
  partnerTruck = await truckIdOf(partnerOwner.tenantId, "STS-201");
});

beforeEach(async () => {
  await updateSettings(owner, { claimMode: "immediate", podAutoApprove: false });
  setPushSender(null);
  setSmsProvider(null);
});

afterEach(() => {
  setPushSender(null);
  setSmsProvider(null);
});

afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

const mk = async () => (await createTrip(dispatcher, tripInput(customerId))).id;
const podFields = () => ({
  outcome: "complete" as "complete" | "partial" | "discrepancy" | "failed",
  receiverName: "Maria Santos",
  actualDeliveryAt: new Date(Date.now() - 3600_000).toISOString(),
  gpsConsent: "unavailable" as const,
  idempotencyKey: `n-${Date.now()}-${k++}-${Math.random().toString(36).slice(2)}`,
});
const submit = async (a: TenantActor, tripId: string, over: Partial<ReturnType<typeof podFields>> & { discrepancyNotes?: string } = {}) => {
  const r = await submitRaw(a, tripId, { ...podFields(), ...over }, [{ name: "r.png", data: PNG }]);
  await drain();
  return r;
};
/** What a person was told about a trip (or other entity), oldest first. */
async function told(a: TenantActor, entityId: string) {
  const rows = await admin.db.select().from(notifications).where(and(eq(notifications.userId, a.userId), eq(notifications.entityId, entityId)));
  return rows.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
}
const kinds = async (a: TenantActor, entityId: string) => (await told(a, entityId)).map((n) => n.kind);
async function atDestination(worker: TenantActor, id: string, partner = false) {
  if (partner) {
    await createOffer(dispatcher, id, { mode: "broadcast_partners" });
    await partnerAccept(partnerOwner, owner.tenantId, id, { truckId: partnerTruck, driverUserId: partnerDriver.userId });
  } else {
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await claimTrip(worker, id, { truckId: acmeTruck });
  }
  await drain();
  for (const to of ["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"] as const) await advanceTrip(worker, id, to);
  await drain();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function drainUntil(done: () => Promise<boolean>) {
  for (let i = 0; i < 40; i++) {
    await drainJobs({ limit: 500, backoffBaseMs: 1 });
    if (await done()) return;
    await sleep(15);
  }
  throw new Error("condition never became true");
}
const setPhone = (a: TenantActor, phone: string | null, smsEnabled: boolean) => saveNotificationSettings(a, { phone, smsEnabled });
const deliveriesOf = async (n: { id: string }) => await admin.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, n.id));

describe("who is told about a new offer", () => {
  it("broadcast to our drivers: every active driver, nobody else; the link opens the trip", async () => {
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await drain();
    for (const d of [driver, driver2]) {
      const n = (await told(d, id)).find((x) => x.kind === "offer.new")!;
      expect(n).toMatchObject({ title: "New trip available", link: `/app/trips/${id}`, tenantId: owner.tenantId });
      expect(n.body).toMatch(/Calamba, Laguna to Taguig City/);
    }
    for (const other of [dispatcher, accountant, partnerOwner, partnerDriver, bayanOwner]) expect(await kinds(other, id)).toEqual([]);
  });

  it("broadcast to subcontractors: their owner is told in their own company, through the partner link; our drivers are not", async () => {
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_partners" });
    await drain();
    const n = (await told(partnerOwner, id))[0];
    expect(n).toMatchObject({ kind: "offer.new", tenantId: partnerOwner.tenantId, link: `/app/partner/${owner.tenantId}/${id}` });
    expect(await kinds(driver, id)).toEqual([]);
    expect(await kinds(partnerDriver, id)).toEqual([]); // only company managers are offered work
  });

  it("direct to a driver, direct to a company, chosen drivers, and an open call", async () => {
    const a = await mk();
    await createOffer(dispatcher, a, { mode: "direct", driverUserId: driver.userId });
    const b = await mk();
    await createOffer(dispatcher, b, { mode: "direct", partnerTenantId: partnerOwner.tenantId });
    const c = await mk();
    await createOffer(dispatcher, c, { mode: "selected", userIds: [driver2.userId] });
    const d = await mk();
    await createOffer(dispatcher, d, { mode: "applicants", audience: "internal" });
    await drain();
    expect(await kinds(driver, a)).toEqual(["offer.direct"]);
    expect(await kinds(driver2, a)).toEqual([]);
    expect(await kinds(partnerOwner, b)).toEqual(["offer.direct"]);
    expect(await kinds(driver, b)).toEqual([]);
    expect(await kinds(driver2, c)).toEqual(["offer.new"]);
    expect(await kinds(driver, c)).toEqual([]);
    expect(await kinds(driver, d)).toEqual(["offer.open_call"]);
  });
});

describe("accepting, requests and acknowledgements", () => {
  it("an immediate acceptance tells dispatch, tells the others the trip is gone, and tells the claimer nothing", async () => {
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await drain();
    await claimTrip(driver, id, { truckId: acmeTruck });
    await drain();
    for (const staff of [dispatcher, owner]) {
      const n = (await told(staff, id)).find((x) => x.kind === "trip.claimed")!;
      expect(n.body).toMatch(/Acme Driver accepted/);
    }
    expect(await kinds(driver2, id)).toEqual(["offer.new", "offer.closed"]);
    expect(await kinds(driver, id)).toEqual(["offer.new"]); // they accepted it: no "taken" notice
    expect(await kinds(accountant, id)).toEqual([]);
  });

  it("a request tells dispatch; approval tells the applicant; losers are told why", async () => {
    await updateSettings(owner, { claimMode: "approval_required" });
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    await claimTrip(driver2, id, { truckId: await truckIdOf(owner.tenantId, "ACM-102") });
    await drain();
    expect((await kinds(dispatcher, id)).filter((x) => x === "application.new")).toHaveLength(2);
    const apps = (await getTripForStaff(dispatcher, id)).applications;
    const mine = apps.find((a) => a.applicantName === "Acme Driver")!;
    await decideApplication(dispatcher, mine.id, { decision: "approve" });
    await drain();
    expect(await kinds(driver, id)).toEqual(["offer.new", "application.approved"]); // exactly one: no duplicate "assigned" notice
    const lost = (await told(driver2, id)).find((x) => x.kind === "application.declined")!;
    expect(lost.body).toMatch(/Another assignment was made/);
  });

  it("a declined request carries the dispatcher's reason", async () => {
    await updateSettings(owner, { claimMode: "approval_required" });
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    const appId = (await getTripForStaff(dispatcher, id)).applications[0].id;
    await decideApplication(dispatcher, appId, { decision: "decline", reason: "Closer driver available" });
    await drain();
    const n = (await told(driver, id)).find((x) => x.kind === "application.declined")!;
    expect(n.body).toMatch(/Closer driver available/);
  });

  it("a subcontractor's acceptance tells its driver they were assigned, and dispatch who accepted", async () => {
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_partners" });
    await partnerAccept(partnerOwner, owner.tenantId, id, { truckId: partnerTruck, driverUserId: partnerDriver.userId });
    await drain();
    const assigned = (await told(partnerDriver, id))[0];
    expect(assigned).toMatchObject({ kind: "trip.assigned", tenantId: partnerOwner.tenantId, link: `/app/trips/${id}` });
    expect((await told(dispatcher, id)).find((x) => x.kind === "trip.claimed")!.body).toMatch(/Santos Driver \(Santos Trucking/);
    expect((await kinds(partnerOwner, id)).includes("trip.assigned")).toBe(false); // they did the accepting
  });

  it("declining a direct offer tells dispatch, for a driver and for a subcontractor", async () => {
    const a = await mk();
    await createOffer(dispatcher, a, { mode: "direct", driverUserId: driver.userId });
    await declineOffer(driver, a);
    const b = await mk();
    await createOffer(dispatcher, b, { mode: "direct", partnerTenantId: partnerOwner.tenantId });
    await partnerDecline(partnerOwner, owner.tenantId, b);
    await drain();
    expect((await told(dispatcher, a)).find((x) => x.kind === "offer.declined")!.body).toMatch(/Acme Driver declined/);
    expect((await told(dispatcher, b)).find((x) => x.kind === "offer.declined")!.body).toMatch(/Santos Owner declined/);
  });

  it("an offer that times out tells dispatch, found by the timer without anyone looking", async () => {
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_internal", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await admin.db.update(tripOffers).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tripOffers.tripId, id));
    const r = await runAutomations();
    expect(r.expired).toBeGreaterThanOrEqual(1);
    await drain();
    expect(await kinds(dispatcher, id)).toContain("offer.expired");
    await runAutomations();
    await drain();
    expect((await kinds(dispatcher, id)).filter((x) => x === "offer.expired")).toHaveLength(1); // not repeated
    void cancelOffer;
  });
});

describe("the trip's progress", () => {
  it("tells dispatch when the driver arrives, not for every status", async () => {
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    for (const to of ["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"] as const) await advanceTrip(driver, id, to);
    await drain();
    const got = await kinds(dispatcher, id);
    expect(got).toEqual(expect.arrayContaining(["trip.arrived_pickup", "trip.arrived_destination"]));
    expect(got.filter((x) => x.startsWith("trip.arrived"))).toHaveLength(2);
    expect((await told(dispatcher, id)).find((x) => x.kind === "trip.arrived_pickup")!.body).toMatch(/Acme Driver arrived at the pickup/);
  });

  it("proof uploaded tells dispatch; an exception is flagged as one; the driver hears each decision", async () => {
    const id = await mk();
    await atDestination(driver, id);
    const ok = await submit(driver, id);
    expect(await kinds(dispatcher, id)).toContain("pod.submitted");
    await reviewPod(dispatcher, ok.submissionId, { decision: "reject", reason: "Photo is blurry" });
    await drain();
    const rejected = (await told(driver, id)).find((x) => x.kind === "pod.rejected")!;
    expect(rejected.body).toMatch(/Photo is blurry/);
    const v2 = await submit(driver, id, { outcome: "partial", discrepancyNotes: "2 pallets short" });
    expect(await kinds(dispatcher, id)).toContain("pod.exception");
    await reviewPod(dispatcher, v2.submissionId, { decision: "approve", reason: "Customer accepted the shortage" });
    await drain();
    expect(await kinds(driver, id)).toContain("pod.approved");
  });

  it("a finished trip tells dispatch it is complete and finance it can be invoiced, each to the right people", async () => {
    const id = await mk();
    await atDestination(driver, id);
    const s = await submit(driver, id);
    await reviewPod(dispatcher, s.submissionId, { decision: "approve" });
    await drain();
    expect(await kinds(accountant, id)).toEqual(["invoice.ready"]);
    expect(await kinds(owner, id)).toContain("invoice.ready");
    expect(await kinds(dispatcher, id)).toContain("trip.completed");
    expect(await kinds(ops, id)).toContain("trip.completed");
    expect(await kinds(dispatcher, id)).not.toContain("invoice.ready");
    expect((await told(accountant, id))[0].link).toBe("/app/invoices");
  });

  it("automatic approval is announced to the driver as automatic", async () => {
    await updateSettings(owner, { claimMode: "immediate", podAutoApprove: true });
    const id = await mk();
    await atDestination(driver, id);
    await submitRaw(driver, id, podFields(), [{ name: "a.png", data: PNG }, { name: "b.png", data: PNG }]);
    await drain();
    const n = (await told(driver, id)).find((x) => x.kind === "pod.approved")!;
    expect(n.body).toMatch(/automatically/);
    expect(await kinds(accountant, id)).toContain("invoice.ready");
  });

  it("a subcontractor trip: proof decisions reach the driver and the company, reassignment and cancellation too", async () => {
    const id = await mk();
    await atDestination(partnerDriver, id, true);
    const s = await submit(partnerDriver, id);
    await reviewPod(dispatcher, s.submissionId, { decision: "request_more", reason: "Add the signed receipt" });
    await drain();
    for (const p of [partnerDriver, partnerOwner]) expect((await kinds(p, id)).includes("pod.more_requested"), p.userId).toBe(true);

    const early = await mk();
    await createOffer(dispatcher, early, { mode: "broadcast_partners" });
    await partnerAccept(partnerOwner, owner.tenantId, early, { truckId: partnerTruck, driverUserId: partnerDriver.userId });
    await drain();
    await reassignTrip(dispatcher, early, "Wrong truck type");
    await drain();
    const released = (await told(partnerDriver, early)).find((x) => x.kind === "assignment.released")!;
    expect(released.body).toMatch(/Wrong truck type/);
    expect(await kinds(partnerOwner, early)).toContain("assignment.released");

    const third = await mk();
    await createOffer(dispatcher, third, { mode: "broadcast_internal" });
    await claimTrip(driver, third, { truckId: acmeTruck });
    await cancelTrip(dispatcher, third);
    await drain();
    expect(await kinds(driver, third)).toContain("trip.cancelled");
  });

  it("an exception nobody reviews is escalated once to the owner and ops manager", async () => {
    const id = await mk();
    await atDestination(driver, id);
    await submit(driver, id, { outcome: "failed", discrepancyNotes: "Nobody to receive the goods" });
    expect((await runAutomations({ escalateAfterMs: 60 * 60_000 })).escalated).toBe(0); // not old enough yet
    await sleep(5);
    expect((await runAutomations({ escalateAfterMs: 0 })).escalated).toBeGreaterThanOrEqual(1);
    await drain();
    await runAutomations({ escalateAfterMs: 0 });
    await drain();
    for (const p of [owner, ops]) expect((await kinds(p, id)).filter((x) => x === "pod.exception_escalated")).toHaveLength(1);
    expect(await kinds(accountant, id)).not.toContain("pod.exception_escalated");
  });
});

describe("finance notifications", () => {
  it("settlements tell the subcontractor's managers; expenses tell finance and then the driver", async () => {
    const id = await mk();
    await atDestination(partnerDriver, id, true);
    const s = await submit(partnerDriver, id);
    await reviewPod(dispatcher, s.submissionId, { decision: "approve" });
    const set = await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [id], idempotencyKey: `sn-${Date.now()}` });
    await markSettlementPaid(accountant, set.id, { reference: "GCash 1" });
    await drain();
    const mine = await told(partnerOwner, set.id);
    expect(mine.map((n) => n.kind)).toEqual(["settlement.issued", "settlement.paid"]);
    expect(mine[0].link).toBe(`/app/settlements/from/${owner.tenantId}/${set.id}`);

    const trip = await mk();
    await atDestination(driver, trip);
    const e = await submitExpense(driver, trip, { category: "fuel", amountCentavos: 150_000, incurredAt: new Date(Date.now() - 3600_000).toISOString(), idempotencyKey: `ex-${Date.now()}-${k++}` }, { name: "r.png", data: PNG });
    await drain();
    expect(await kinds(accountant, e.id)).toEqual(["expense.submitted"]);
    await reviewExpense(accountant, e.id, { decision: "reject", note: "Personal use" });
    await drain();
    expect((await told(driver, e.id))[0].body).toMatch(/rejected: Personal use/);
    void addCompanyExpense;
  });
});

describe("never twice", () => {
  it("running the same events again does not create a second notification for anyone", async () => {
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await drain();
    const before = await admin.db.select().from(notifications).where(eq(notifications.entityId, id));
    // put THIS trip's finished jobs back in the queue, as if the worker had crashed after doing the work but before recording it
    await admin.sql`update jobs set status = 'queued', attempts = 0, run_at = now() where type = 'notify.event' and payload->>'tripId' = ${id}`;
    await admin.sql`update jobs set status = 'queued', attempts = 0, run_at = now() where type = 'notify.deliver' and payload->>'notificationId' = any(${before.map((n) => n.id)})`;
    await drain();
    const after = await admin.db.select().from(notifications).where(eq(notifications.entityId, id));
    expect(after.map((n) => n.id).sort()).toEqual(before.map((n) => n.id).sort());
  });

  it("the timer job is enqueued once per minute however many servers ask", async () => {
    await enqueueAutomationTick();
    await enqueueAutomationTick();
    const minute = new Date().toISOString().slice(0, 16);
    expect(await admin.db.select().from(jobs).where(eq(jobs.dedupeKey, `tick:${minute}`))).toHaveLength(1);
    await drain();
  });
});

describe("delivery: push first, then SMS for urgent items", () => {
  const fakeSender = (script: ("sent" | "gone" | "retry" | "fatal")[]) => {
    const calls: string[] = [];
    const sender: PushSender = {
      configured: () => true,
      async send(t) {
        calls.push(t.endpoint);
        const next = script.length > 1 ? script.shift()! : script[0];
        if (next === "sent") return { status: "sent" };
        if (next === "gone") return { status: "gone" };
        if (next === "retry") return { status: "error", retryable: true, detail: "push service busy" };
        return { status: "error", retryable: false, detail: "rejected" };
      },
    };
    return { sender, calls };
  };
  const addDevice = async (a: TenantActor, n = 1) => {
    for (let i = 0; i < n; i++) await admin.db.insert(pushSubscriptions).values({ userId: a.userId, endpoint: `https://push.example/${a.userId}/${Date.now()}-${i}-${k++}`, p256dh: "p", auth: "a" });
  };
  const clearDevices = (a: TenantActor) => admin.db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, a.userId));
  const offerTo = async (a: TenantActor) => {
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "direct", driverUserId: a.userId });
    return id;
  };
  const smsRows = async (n: { id: string }) => (await deliveriesOf(n)).find((d) => d.channel === "sms");
  const pushRow = async (n: { id: string }) => (await deliveriesOf(n)).find((d) => d.channel === "push");

  it("a delivered push means no text message", async () => {
    const d = await extraDriver(owner.tenantId);
    await setPhone(d, "0917 555 0001", true);
    await addDevice(d);
    const { sender } = fakeSender(["sent"]);
    setPushSender(sender);
    const sms: SmsProvider = { name: "fake", real: true, send: async () => ({ ok: true }) };
    setSmsProvider(sms);
    const id = await offerTo(d);
    await drain();
    const n = (await told(d, id))[0];
    expect((await pushRow(n))?.status).toBe("sent");
    expect((await smsRows(n))).toMatchObject({ status: "skipped", detail: "push delivered" });
  });

  it("a device that has unsubscribed is forgotten, and an urgent item falls back to one text message", async () => {
    const d = await extraDriver(owner.tenantId);
    await setPhone(d, "09175550002", true);
    await addDevice(d);
    const { sender } = fakeSender(["gone"]);
    setPushSender(sender);
    const sent: string[] = [];
    setSmsProvider({ name: "fake", real: true, send: async (to, text) => (sent.push(`${to}|${text}`), { ok: true }) });
    const id = await offerTo(d);
    await drain();
    await drain();
    const n = (await told(d, id))[0];
    expect(await admin.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, d.userId))).toHaveLength(0);
    expect((await pushRow(n))?.status).toBe("none");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\+639175550002\|Truckwise: A trip was offered to you\. TR-/);
    expect(sent[0]).not.toMatch(/₱|PHP|\d,\d{3}/);
    expect((await smsRows(n))?.status).toBe("sent");
  });

  it("a temporary push failure is retried later and the person still gets exactly one notification and one push", async () => {
    const d = await extraDriver(owner.tenantId);
    await addDevice(d);
    const { sender, calls } = fakeSender(["retry", "retry", "sent"]);
    setPushSender(sender);
    const id = await offerTo(d);
    await drainUntil(async () => {
      const n = (await told(d, id))[0];
      return !!n && (await pushRow(n))?.status === "sent";
    });
    const rows = await told(d, id);
    expect(rows).toHaveLength(1);
    expect(calls.length).toBe(3);
    const row = await pushRow(rows[0]);
    expect(row?.attempts).toBe(3);
  });

  it("no text for non-urgent items, for people with SMS off, or without a number; the stub never really sends", async () => {
    const quiet = await extraDriver(owner.tenantId);
    // SMS on but item is not urgent: dispatch notices are informational
    await setPhone(dispatcher, "09175550003", true);
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    await advanceTrip(driver, id, "started");
    await advanceTrip(driver, id, "arrived_pickup");
    await drain();
    const arrived = (await told(dispatcher, id)).find((x) => x.kind === "trip.arrived_pickup")!;
    expect(await smsRows(arrived)).toMatchObject({ status: "skipped", detail: "not urgent" });
    await setPhone(dispatcher, null, false);

    // urgent, but this person never turned SMS on
    const id2 = await offerTo(quiet);
    await drain();
    const n = (await told(quiet, id2))[0];
    expect(await smsRows(n)).toMatchObject({ status: "skipped", detail: "SMS is off for this person" });
    expect(stubSent.filter((m) => m.to === "+639175550003")).toHaveLength(0); // the dispatcher's non-urgent items sent nothing
    expect(stubSent.filter((m) => m.to === "+639175550004")).toHaveLength(0); // and nothing went to someone who never opted in

    // the default provider is the stub: an urgent item to someone with SMS on is recorded as "stub", not claimed as sent to a phone
    await setPhone(quiet, "09175550004", true);
    const id3 = await offerTo(quiet);
    await drain();
    const n3 = (await told(quiet, id3))[0];
    expect(await smsRows(n3)).toMatchObject({ status: "sent", detail: expect.stringMatching(/stub provider: nothing was really sent/) });
    expect(stubSent.filter((m) => m.to === "+639175550004")).toHaveLength(1);
  });

  it("caps text messages per person per day", async () => {
    process.env.SMS_DAILY_LIMIT = "2";
    try {
      const d = await extraDriver(owner.tenantId);
      await setPhone(d, "09175550005", true);
      let sentCount = 0;
      setSmsProvider({ name: "fake", real: true, send: async () => (sentCount++, { ok: true }) });
      const ids = [await offerTo(d), await offerTo(d), await offerTo(d)];
      await drain();
      const states = [];
      for (const id of ids) states.push((await smsRows((await told(d, id))[0]))?.status);
      expect(states.filter((s) => s === "sent")).toHaveLength(2);
      expect(states.filter((s) => s === "skipped")).toHaveLength(1);
      expect(sentCount).toBe(2);
    } finally {
      delete process.env.SMS_DAILY_LIMIT;
    }
  });

  it("a text that fails temporarily is retried and sent once; a permanent failure is recorded and not retried", async () => {
    const d = await extraDriver(owner.tenantId);
    await setPhone(d, "09175550006", true);
    let calls = 0;
    setSmsProvider({ name: "fake", real: true, send: async () => (++calls < 3 ? { ok: false, retryable: true, detail: "gateway busy" } : { ok: true }) });
    const id = await offerTo(d);
    await drainUntil(async () => {
      const n = (await told(d, id))[0];
      return !!n && (await smsRows(n))?.status === "sent";
    });
    expect(calls).toBe(3);
    expect(await told(d, id)).toHaveLength(1);

    const e = await extraDriver(owner.tenantId);
    await setPhone(e, "09175550007", true);
    let bad = 0;
    setSmsProvider({ name: "fake", real: true, send: async () => (++bad, { ok: false, retryable: false, detail: "invalid number" }) });
    const id2 = await offerTo(e);
    await drain();
    await drain();
    const n2 = (await told(e, id2))[0];
    expect(await smsRows(n2)).toMatchObject({ status: "failed", detail: "invalid number" });
    expect(bad).toBe(1);
  });

  it("without VAPID keys push is 'none' (in-app only)", async () => {
    const d = await extraDriver(owner.tenantId);
    await addDevice(d);
    const id = await offerTo(d);
    await drain();
    const n = (await told(d, id))[0];
    expect(await pushRow(n)).toMatchObject({ status: "none", detail: "Web Push is not configured" });
    await clearDevices(d);
  });
});

describe("reading and settings", () => {
  it("each person reads only their own notifications, and marks only their own as read", async () => {
    const id = await mk();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await drain();
    const mine = await listNotifications(driver);
    expect(mine.some((n) => n.link === `/app/trips/${id}`)).toBe(true);
    const theirs = await listNotifications(driver2);
    const theirId = theirs.find((n) => n.link === `/app/trips/${id}`)!.id;
    expect(await markRead(driver, { ids: [theirId] })).toEqual({ marked: 0 }); // not theirs: untouched
    expect((await listNotifications(driver2)).find((n) => n.id === theirId)!.read).toBe(false);
    const before = await unreadCount(driver);
    expect(before).toBeGreaterThan(0);
    const first = mine.find((n) => !n.read)!;
    expect(await markRead(driver, { ids: [first.id] })).toEqual({ marked: 1 });
    expect(await unreadCount(driver)).toBe(before - 1);
    await markRead(driver, { all: true });
    expect(await unreadCount(driver)).toBe(0);
    // at the database: owners cannot read a driver's notifications, nor another company's people
    const asOwner = await withTenant(owner.tenantId, owner.userId, (db) => db.select().from(notifications));
    expect(asOwner.every((n) => n.userId === owner.userId)).toBe(true);
    expect(await withTenant(bayanOwner.tenantId, bayanOwner.userId, (db) => db.select().from(notifications))).toEqual([]);
    await expect(withTenant(driver.tenantId, driver.userId, (db) => db.delete(notifications))).rejects.toThrow();
    await expect(withTenant(driver.tenantId, driver.userId, (db) => db.update(notifications).set({ title: "forged" }))).rejects.toThrow();
  });

  it("no notification anywhere contains money", async () => {
    const all = await admin.db.select().from(notifications);
    expect(all.length).toBeGreaterThan(20);
    for (const n of all) expect(`${n.title} ${n.body}`, n.kind).not.toMatch(/₱|PHP|peso|centavo|(^|[^a-z])contract([^a-z]|$)|payout|profit|\d{1,3}(,\d{3})+/i);
  });

  it("phone numbers are validated and stored in one form; SMS needs a number", async () => {
    const d = await extraDriver(owner.tenantId);
    await expect(saveNotificationSettings(d, { phone: "12345", smsEnabled: false })).rejects.toMatchObject({ status: 400 });
    await expect(saveNotificationSettings(d, { phone: null, smsEnabled: true })).rejects.toMatchObject({ status: 400 });
    expect(await saveNotificationSettings(d, { phone: "0917 123 4567", smsEnabled: true })).toEqual({ phone: "+639171234567", smsEnabled: true });
    const s = await getNotificationSettings(d);
    expect(s).toMatchObject({ phone: "+639171234567", smsEnabled: true, devices: 0, smsProviderIsReal: false, pushConfigured: false });
    const stored = await admin.db.select().from(userNotificationSettings).where(eq(userNotificationSettings.userId, d.userId));
    expect(stored[0].phone).toBe("+639171234567");
    // one person cannot read or change another's settings through the database
    const other = await withTenant(driver.tenantId, driver.userId, (db) => db.select().from(userNotificationSettings));
    expect(other.every((r) => r.userId === driver.userId)).toBe(true);
  });

  it("a device can be added and removed; an endpoint that moves to another account leaves the first", async () => {
    const endpoint = `https://push.example/device-${Date.now()}`;
    const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
    await subscribePush(driver, { endpoint, keys }, "TestBrowser/1");
    expect((await getNotificationSettings(driver)).devices).toBeGreaterThanOrEqual(1);
    await subscribePush(driver2, { endpoint, keys }, "TestBrowser/1"); // same phone, someone else signed in
    expect(await admin.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toMatchObject([{ userId: driver2.userId }]);
    await unsubscribePush(driver, endpoint); // not theirs any more: nothing happens
    expect(await admin.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toHaveLength(1);
    await unsubscribePush(driver2, endpoint);
    expect(await admin.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))).toHaveLength(0);
  });
});
