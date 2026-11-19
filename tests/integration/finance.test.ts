import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/server/db";
import { auditLog, customers, invoiceLines, invoices, settlementLines, settlements, tripExpenses, trips } from "@/server/db/schema";
import { buildInvoicePdf } from "@/server/services/finance/invoice-pdf";
import {
  generateInvoice,
  getInvoice,
  invoiceAllReady,
  invoiceableTrips,
  listInvoices,
  markInvoicePaid,
  voidInvoice,
} from "@/server/services/finance/invoices";
import { addCompanyExpense, listExpensesToReview, listMyTripExpenses, reviewExpense, submitExpense, type ExpenseInput } from "@/server/services/finance/expenses";
import { driverEarnings } from "@/server/services/finance/earnings";
import { updateTripMoney } from "@/server/services/finance/money";
import { profitSummary, tripFinancials } from "@/server/services/finance/profit";
import {
  generateSettlement,
  getMySettlement,
  listMySettlements,
  listSettlements,
  markSettlementPaid,
  settleAllReady,
  settleableTrips,
  voidSettlement,
} from "@/server/services/finance/settlements";
import { claimTrip, createOffer } from "@/server/services/offers";
import { partnerAccept } from "@/server/services/partner";
import { inviteSubcontractor } from "@/server/services/partners";
import { reviewPod, submitPod as submitRaw } from "@/server/services/pod";
import { updateSettings } from "@/server/services/settings";
import { advanceTrip, createTrip, type TenantActor } from "@/server/services/trips";
import { PNG, actorFor, admin, customerOf, drain, extraDriver, truckIdOf, tripInput } from "../helpers";

let owner: TenantActor, dispatcher: TenantActor, accountant: TenantActor, driver: TenantActor, opsDriver: TenantActor;
let partnerOwner: TenantActor, partnerDriver: TenantActor, bayanOwner: TenantActor;
let customerA: string, customerB: string, acmeTruck: string, partnerTruck: string;
let k = 0;
const key = () => `fin-${Date.now()}-${k++}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  owner = await actorFor("owner@acme.test");
  dispatcher = await actorFor("dispatcher@acme.test");
  accountant = await actorFor("accountant@acme.test");
  driver = await actorFor("driver@acme.test");
  opsDriver = await extraDriver(owner.tenantId);
  partnerOwner = await actorFor("owner@santos.test");
  partnerDriver = await actorFor("driver@santos.test");
  bayanOwner = await actorFor("owner@bayan.test");
  const all = await admin.db.select().from(customers).where(eq(customers.tenantId, owner.tenantId));
  customerA = all[0].id;
  customerB = all[1].id;
  acmeTruck = await truckIdOf(owner.tenantId, "ACM-101");
  partnerTruck = await truckIdOf(partnerOwner.tenantId, "STS-201");
  void customerOf;
});

beforeEach(async () => {
  await updateSettings(owner, { claimMode: "immediate", podAutoApprove: false, vatBps: 0 });
});

afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

const submit = async (a: TenantActor, tripId: string, input: Parameters<typeof submitRaw>[2], files: Parameters<typeof submitRaw>[3]) => {
  const r = await submitRaw(a, tripId, input, files);
  await drain();
  return r;
};
const podFields = () => ({
  outcome: "complete" as const,
  receiverName: "Maria Santos",
  actualDeliveryAt: new Date(Date.now() - 3600_000).toISOString(),
  gpsConsent: "unavailable" as const,
  idempotencyKey: key(),
});
const photo = { name: "r.png", data: PNG };
const signature = { name: "s.png", data: PNG, kind: "signature" as const };

/** A trip taken all the way to "ready for invoice" by the company's own driver, or by the subcontractor. */
async function readyTrip(opts: { customerId?: string; rate?: number; payout?: number; partner?: boolean; fuelIncluded?: boolean } = {}) {
  const id = (
    await createTrip(
      dispatcher,
      tripInput(opts.customerId ?? customerA, { contractRateCentavos: opts.rate ?? 1_850_000, payoutCentavos: opts.payout ?? 1_400_000, fuelIncluded: opts.fuelIncluded ?? false }),
    )
  ).id;
  const worker = opts.partner ? partnerDriver : driver;
  if (opts.partner) {
    await createOffer(dispatcher, id, { mode: "broadcast_partners" });
    await partnerAccept(partnerOwner, owner.tenantId, id, { truckId: partnerTruck, driverUserId: partnerDriver.userId });
  } else {
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
  }
  for (const to of ["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"] as const) await advanceTrip(worker, id, to);
  const { submissionId } = await submit(worker, id, podFields(), [photo, signature]);
  await reviewPod(dispatcher, submissionId, { decision: "approve" });
  return id;
}
async function openTrip() {
  const id = (await createTrip(dispatcher, tripInput(customerA))).id;
  await createOffer(dispatcher, id, { mode: "broadcast_internal" });
  await claimTrip(driver, id, { truckId: acmeTruck });
  return id;
}
const expense = (over: Partial<ExpenseInput> = {}): ExpenseInput => ({ category: "fuel", amountCentavos: 250_000, incurredAt: new Date(Date.now() - 3600_000).toISOString(), idempotencyKey: key(), ...over });

describe("changing a trip's money", () => {
  it("records old and new values with a reason, and only for the roles that handle money", async () => {
    const id = await openTrip();
    await expect(updateTripMoney(dispatcher, id, { contractRateCentavos: 2_000_000, reason: "Customer agreed" })).rejects.toThrow(/Forbidden/);
    await expect(updateTripMoney(driver, id, { payoutCentavos: 9_999_999, reason: "I want more" })).rejects.toThrow(/Forbidden/);
    await expect(updateTripMoney(accountant, id, { reason: "nothing" } as never)).rejects.toThrow();
    await updateTripMoney(accountant, id, { contractRateCentavos: 2_100_000, payoutCentavos: 1_500_000, reason: "Fuel surcharge agreed with the client" });
    const [t] = await admin.db.select().from(trips).where(eq(trips.id, id));
    expect([t.contractRateCentavos, t.payoutCentavos]).toEqual([2_100_000, 1_500_000]);
    const audit = (await admin.db.select().from(auditLog).where(eq(auditLog.entityId, id))).find((a) => a.action === "trip.money")!;
    expect(audit.oldValue).toEqual({ contractRateCentavos: 1_850_000, payoutCentavos: 1_400_000 });
    expect(audit.newValue).toMatchObject({ contractRateCentavos: 2_100_000, payoutCentavos: 1_500_000, reason: "Fuel surcharge agreed with the client" });
    await expect(updateTripMoney(accountant, id, { payoutCentavos: 1_500_000, reason: "same value" })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a rate change on an invoiced trip and a payout change on a settled trip until the document is voided", async () => {
    const id = await readyTrip({ partner: true });
    const inv = await generateInvoice(accountant, { customerId: customerA, tripIds: [id], idempotencyKey: key() });
    await expect(updateTripMoney(accountant, id, { contractRateCentavos: 1, reason: "too late" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Void the invoice/) });
    await updateTripMoney(accountant, id, { payoutCentavos: 1_300_000, reason: "Partner agreed a lower rate" }); // payout is not settled yet
    const set = await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [id], idempotencyKey: key() });
    await expect(updateTripMoney(accountant, id, { payoutCentavos: 1, reason: "too late" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Void the settlement/) });
    await voidInvoice(accountant, inv.id, "Wrong client rate");
    await updateTripMoney(accountant, id, { contractRateCentavos: 1_900_000, reason: "Corrected before re-billing" });
    await voidSettlement(accountant, set.id, "Re-do after correction");
  });
});

describe("invoices", () => {
  it("lists only finished, unbilled trips, grouped by customer", async () => {
    const a = await readyTrip({ customerId: customerA });
    const b = await readyTrip({ customerId: customerB });
    const notDone = await openTrip();
    const groups = await invoiceableTrips(accountant);
    const all = groups.flatMap((g) => g.trips.map((t) => t.id));
    expect(all).toEqual(expect.arrayContaining([a, b]));
    expect(all).not.toContain(notDone);
    expect(groups.find((g) => g.customerId === customerA)!.trips.map((t) => t.id)).toContain(a);
    expect(groups.find((g) => g.customerId === customerA)!.trips.map((t) => t.id)).not.toContain(b);
  });

  it("fixes the amounts at issue: customer rate per trip, VAT rounded to the centavo, sequential numbers", async () => {
    await updateSettings(owner, { claimMode: "immediate", vatBps: 1200 });
    const t1 = await readyTrip({ rate: 1_234_567 });
    const t2 = await readyTrip({ rate: 765_433 });
    const first = await generateInvoice(accountant, { customerId: customerA, tripIds: [t1, t2], idempotencyKey: key() });
    const inv = await getInvoice(accountant, first.id);
    expect(inv.subtotalCentavos).toBe(2_000_000);
    expect(inv.vatBps).toBe(1200);
    expect(inv.vatCentavos).toBe(240_000);
    expect(inv.totalCentavos).toBe(2_240_000);
    expect(inv.lines.map((l) => l.amountCentavos).sort((a, b) => a - b)).toEqual([765_433, 1_234_567]);
    expect(first.number).toMatch(/^INV-\d{4}-\d{4}$/);
    // a later rate change on the trip does not touch the issued invoice
    await expect(updateTripMoney(accountant, t1, { contractRateCentavos: 5, reason: "later change" })).rejects.toMatchObject({ status: 409 });
    expect((await getInvoice(accountant, first.id)).totalCentavos).toBe(2_240_000);

    const t3 = await readyTrip({ rate: 100_000 });
    const second = await generateInvoice(accountant, { customerId: customerA, tripIds: [t3], idempotencyKey: key() });
    const seq = (n: string) => Number(n.split("-")[2]);
    expect(seq(second.number)).toBe(seq(first.number) + 1);
  });

  it("refuses trips of another client, unfinished trips, unknown trips and other companies' trips", async () => {
    const mine = await readyTrip({ customerId: customerA });
    await expect(generateInvoice(accountant, { customerId: customerB, tripIds: [mine], idempotencyKey: key() })).rejects.toMatchObject({ status: 400 });
    const open = await openTrip();
    await expect(generateInvoice(accountant, { customerId: customerA, tripIds: [open], idempotencyKey: key() })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Not ready/) });
    await expect(generateInvoice(accountant, { customerId: customerA, tripIds: ["00000000-0000-4000-8000-000000000000"], idempotencyKey: key() })).rejects.toMatchObject({ status: 404 });
    const bayanCustomer = (await admin.db.select().from(customers).where(eq(customers.tenantId, bayanOwner.tenantId)))[0].id;
    await expect(generateInvoice(await actorFor("owner@bayan.test"), { customerId: bayanCustomer, tripIds: [mine], idempotencyKey: key() })).rejects.toMatchObject({ status: 404 });
  });

  it("never bills twice: the same key returns the same invoice, and a billed trip is refused under a new key", async () => {
    const t = await readyTrip();
    const k1 = key();
    const a = await generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: k1 });
    const b = await generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: k1 });
    expect(b).toMatchObject({ id: a.id, number: a.number, duplicate: true });
    await expect(generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: key() })).rejects.toMatchObject({ status: 409, code: "already_invoiced" });
    expect(await admin.db.select().from(invoiceLines).where(eq(invoiceLines.tripId, t))).toHaveLength(1);
  });

  it("'invoice everything ready' run twice bills once", async () => {
    const t1 = await readyTrip({ customerId: customerB });
    const t2 = await readyTrip({ customerId: customerB });
    const first = await invoiceAllReady(accountant, customerB, key());
    expect(first.created).toBe(true);
    const lines = await admin.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, first.id!));
    expect(lines.map((l) => l.tripId)).toEqual(expect.arrayContaining([t1, t2])); // other ready trips of this client may be included too
    const second = await invoiceAllReady(accountant, customerB, key());
    expect(second).toEqual({ created: false, id: null, number: null });
  });

  it("two people billing the same trips at once: exactly one invoice is issued", async () => {
    const t1 = await readyTrip();
    const t2 = await readyTrip();
    const results = await Promise.allSettled([
      generateInvoice(accountant, { customerId: customerA, tripIds: [t1, t2], idempotencyKey: key() }),
      generateInvoice(owner, { customerId: customerA, tripIds: [t2, t1], idempotencyKey: key() }),
      generateInvoice(accountant, { customerId: customerA, tripIds: [t1], idempotencyKey: key() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const t of [t1, t2]) {
      const active = (await admin.db.select().from(invoiceLines).where(eq(invoiceLines.tripId, t))).filter((l) => l.active);
      expect(active.length).toBeLessThanOrEqual(1);
    }
    const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>;
    const covered = (await admin.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, winner.value.id))).map((l) => l.tripId);
    expect(covered.length).toBeGreaterThan(0);
  });

  it("the same request sent twice at once returns one invoice", async () => {
    const t = await readyTrip();
    const k1 = key();
    const [a, b] = await Promise.all([
      generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: k1 }),
      generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: k1 }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await admin.db.select().from(invoices).where(eq(invoices.idempotencyKey, k1))).toHaveLength(1);
  });

  it("issued amounts cannot be edited or deleted, even by the table owner, and a paid invoice cannot be voided", async () => {
    const t = await readyTrip();
    const { id } = await generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: key() });
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.update(invoices).set({ totalCentavos: 1 }).where(eq(invoices.id, id)))).rejects.toThrow();
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.delete(invoices).where(eq(invoices.id, id)))).rejects.toThrow();
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.update(invoiceLines).set({ amountCentavos: 1 }))).rejects.toThrow();
    await expect(admin.db.update(invoices).set({ totalCentavos: 1 }).where(eq(invoices.id, id))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/fixed once issued/) } });
    await markInvoicePaid(accountant, id, { reference: "BPI 000123" });
    await expect(markInvoicePaid(accountant, id, { reference: "again" })).rejects.toMatchObject({ status: 409 });
    await expect(voidInvoice(accountant, id, "oops, wanted to void")).rejects.toMatchObject({ status: 409 });
    await expect(admin.db.update(invoices).set({ status: "issued" }).where(eq(invoices.id, id))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/cannot move/) } });
    const detail = await getInvoice(accountant, id);
    expect(detail).toMatchObject({ status: "paid", paymentReference: "BPI 000123" });
  });

  it("voiding an unpaid invoice keeps it on record and lets the trips be billed again under a new number", async () => {
    const t = await readyTrip();
    const first = await generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: key() });
    await expect(voidInvoice(accountant, first.id, "x")).rejects.toMatchObject({ status: 400 });
    await voidInvoice(accountant, first.id, "Billed to the wrong entity");
    expect((await getInvoice(accountant, first.id)).status).toBe("void");
    const again = await generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: key() });
    expect(again.number).not.toBe(first.number);
    const rows = await admin.db.select().from(invoiceLines).where(eq(invoiceLines.tripId, t));
    expect(rows.map((r) => r.active).sort()).toEqual([false, true]);
    const audit = (await admin.db.select().from(auditLog).where(eq(auditLog.entityId, first.id))).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["invoice.issue", "invoice.void"]));
  });

  it("is limited to finance roles: owners and accountants issue, ops managers read, dispatch and drivers see nothing", async () => {
    const t = await readyTrip();
    await expect(generateInvoice(dispatcher, { customerId: customerA, tripIds: [t], idempotencyKey: key() })).rejects.toThrow(/Forbidden/);
    await expect(listInvoices(dispatcher)).rejects.toThrow(/Forbidden/);
    await expect(invoiceableTrips(driver)).rejects.toThrow(/Forbidden/);
    await expect(listInvoices(partnerOwner)).rejects.toThrow(/Forbidden/);
    const { id } = await generateInvoice(owner, { customerId: customerA, tripIds: [t], idempotencyKey: key() });
    const ops = await actorFor("owner@acme.test");
    expect((await listInvoices({ ...ops, role: "ops_manager" })).some((i) => i.id === id)).toBe(true);
    await expect(generateInvoice({ ...ops, role: "ops_manager" }, { customerId: customerA, tripIds: [t], idempotencyKey: key() })).rejects.toThrow(/Forbidden/);
    await expect(getInvoice(await actorFor("owner@bayan.test"), id)).rejects.toMatchObject({ status: 404 });
  });

  it("attaches the approved proof of delivery to each billed trip, and only the approved version", async () => {
    // a trip whose first proof was rejected and the second approved
    const id = (await createTrip(dispatcher, tripInput(customerA))).id;
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    for (const to of ["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"] as const) await advanceTrip(driver, id, to);
    const v1 = await submit(driver, id, { ...podFields(), receiverName: "Blurry Receiver" }, [photo]);
    await reviewPod(dispatcher, v1.submissionId, { decision: "reject", reason: "Photo unreadable" });
    const v2 = await submit(driver, id, { ...podFields(), receiverName: "Clear Receiver" }, [photo, signature]);
    await reviewPod(dispatcher, v2.submissionId, { decision: "approve" });

    const { id: invId } = await generateInvoice(accountant, { customerId: customerA, tripIds: [id], idempotencyKey: key() });
    const inv = await getInvoice(accountant, invId);
    const proof = inv.lines[0].proof;
    expect(proof).toHaveLength(1);
    expect(proof[0]).toMatchObject({ receiverName: "Clear Receiver", outcome: "complete", approvedBy: "Acme Dispatcher" });
    expect(proof[0].photos).toHaveLength(1);
    expect(proof[0].photos[0].url).toContain("/api/files/");
    expect(proof[0].signature).toBeTruthy();
    expect(JSON.stringify(proof)).not.toContain("Blurry Receiver");
    expect(proof[0].deliveredAt).not.toBe(proof[0].uploadedAt);
  });

  it("builds a real PDF: the bill, then a proof page per trip with its photos, even for unusual characters", async () => {
    const [odd] = await admin.db.insert(customers).values({ tenantId: owner.tenantId, name: "Ñandú Café ₱ Trading 😀", address: "Calle Ñ, Quezon City" }).returning();
    const t1 = await readyTrip({ customerId: odd.id });
    const t2 = await readyTrip({ customerId: odd.id });
    const { id } = await generateInvoice(accountant, { customerId: odd.id, tripIds: [t1, t2], idempotencyKey: key() });
    const bytes = await buildInvoicePdf(await getInvoice(accountant, id));
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3); // bill + one proof page per trip
    expect(doc.getTitle()).toContain("Ñandú".replace("Ñ", "Ñ"));
  });
});

describe("subcontractor settlements", () => {
  it("settles only finished trips done by a subcontractor, at the payout agreed on each trip", async () => {
    const external = await readyTrip({ partner: true, payout: 1_100_000 });
    const internal = await readyTrip({ payout: 900_000 });
    const groups = await settleableTrips(accountant);
    const group = groups.find((g) => g.partnerTenantId === partnerOwner.tenantId)!;
    expect(group.trips.map((t) => t.id)).toContain(external);
    expect(groups.flatMap((g) => g.trips.map((t) => t.id))).not.toContain(internal);
    await expect(generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [internal], idempotencyKey: key() })).rejects.toMatchObject({ status: 400 });
    const s = await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [external], idempotencyKey: key() });
    expect(s.number).toMatch(/^SET-\d{4}-\d{4}$/);
    const [row] = await admin.db.select().from(settlements).where(eq(settlements.id, s.id));
    expect(row.totalCentavos).toBe(1_100_000);
    const lines = await admin.db.select().from(settlementLines).where(eq(settlementLines.settlementId, s.id));
    expect(lines.map((l) => l.amountCentavos)).toEqual([1_100_000]);
  });

  it("is idempotent and race-safe, and settling everything twice pays once", async () => {
    const a = await readyTrip({ partner: true });
    const b = await readyTrip({ partner: true });
    const k1 = key();
    const first = await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [a], idempotencyKey: k1 });
    expect(await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [a], idempotencyKey: k1 })).toMatchObject({ id: first.id, duplicate: true });
    await expect(generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [a], idempotencyKey: key() })).rejects.toMatchObject({ status: 409, code: "already_settled" });
    const results = await Promise.allSettled([
      generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [b], idempotencyKey: key() }),
      generateSettlement(owner, { partnerTenantId: partnerOwner.tenantId, tripIds: [b], idempotencyKey: key() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const sweep = await settleAllReady(accountant, partnerOwner.tenantId, key()); // may pick up other ready trips
    void sweep;
    expect((await settleAllReady(accountant, partnerOwner.tenantId, key())).created).toBe(false); // the second run finds nothing
    expect((await admin.db.select().from(settlementLines).where(eq(settlementLines.tripId, b))).filter((l) => l.active)).toHaveLength(1);
  });

  it("a partner sees only the settlements addressed to its own company, never a customer rate", async () => {
    const t = await readyTrip({ partner: true, rate: 4_321_000, payout: 3_000_000 });
    const s = await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [t], idempotencyKey: key() });
    const mine = await listMySettlements(partnerOwner);
    expect(mine.map((x) => x.id)).toContain(s.id);
    const detail = await getMySettlement(partnerOwner, owner.tenantId, s.id);
    expect(detail.totalCentavos).toBe(3_000_000);
    expect(JSON.stringify([mine, detail])).not.toMatch(/contract|4321000/i);

    // another subcontractor of the same company, another company, and company staff see nothing of it
    const other = await inviteSubcontractor(owner, { companyName: "Reyes Hauling", ownerName: "Ana Reyes", ownerEmail: `ana-${Date.now()}@reyes.test`, password: "a-long-password-1" });
    void other;
    const reyes = await actorFor((await admin.db.select().from((await import("@/server/db/schema")).users).where(eq((await import("@/server/db/schema")).users.name, "Ana Reyes")))[0].email);
    expect((await listMySettlements(reyes)).map((x) => x.id)).not.toContain(s.id);
    await expect(getMySettlement(reyes, owner.tenantId, s.id)).rejects.toMatchObject({ status: 404 });
    await expect(getMySettlement(partnerOwner, bayanOwner.tenantId, s.id)).rejects.toMatchObject({ status: 404 });
    await expect(listMySettlements(driver)).rejects.toThrow(/Forbidden/);
    await expect(listMySettlements(partnerDriver)).rejects.toThrow(/Forbidden/);
    expect(await withTenant(partnerOwner.tenantId, partnerOwner.userId, (db) => db.select().from(settlements))).toEqual([]); // not readable from their own context
  });

  it("can be paid or voided once, and voiding frees the trips", async () => {
    const t = await readyTrip({ partner: true });
    const s = await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [t], idempotencyKey: key() });
    await voidSettlement(accountant, s.id, "Wrong partner bank details");
    const s2 = await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [t], idempotencyKey: key() });
    expect(s2.number).not.toBe(s.number);
    await markSettlementPaid(accountant, s2.id, { reference: "GCash 5551234" });
    await expect(voidSettlement(accountant, s2.id, "too late to void")).rejects.toMatchObject({ status: 409 });
    expect((await listSettlements(accountant)).find((x) => x.id === s2.id)?.status).toBe("paid");
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.update(settlements).set({ totalCentavos: 1 }))).rejects.toThrow();
    await expect(listSettlements(dispatcher)).rejects.toThrow(/Forbidden/);
  });
});

describe("expenses", () => {
  it("a driver reports a cost on their own trip with a receipt photo; nobody else can", async () => {
    const id = await openTrip();
    const ok = await submitExpense(driver, id, expense(), { name: "receipt.png", data: PNG });
    expect(ok.duplicate).toBe(false);
    const mine = await listMyTripExpenses(driver, id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: "submitted", companyBears: false });
    expect(mine[0].receiptUrl).toContain("/api/files/");
    await expect(submitExpense(opsDriver, id, expense(), { name: "r.png", data: PNG })).rejects.toMatchObject({ status: 404 });
    await expect(submitExpense(partnerDriver, id, expense(), { name: "r.png", data: PNG })).rejects.toThrow(/Forbidden/);
    await expect(submitExpense(dispatcher, id, expense(), { name: "r.png", data: PNG })).rejects.toThrow(/Forbidden/);
    expect(await listMyTripExpenses(opsDriver, id)).toEqual([]);
  });

  it("insists on a real, clean receipt photo, a sane date and does not duplicate on retry", async () => {
    const id = await openTrip();
    await expect(submitExpense(driver, id, expense(), null)).rejects.toMatchObject({ status: 400 });
    await expect(submitExpense(driver, id, expense(), { name: "r.jpg", data: Buffer.from("not an image") })).rejects.toMatchObject({ status: 400 });
    const eicar = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")]);
    await expect(submitExpense(driver, id, expense(), { name: "virus.jpg", data: eicar })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/security scan/) });
    await expect(submitExpense(driver, id, expense({ incurredAt: new Date(Date.now() + 86_400_000).toISOString() }), { name: "r.png", data: PNG })).rejects.toMatchObject({ status: 400 });
    const input = expense();
    const a = await submitExpense(driver, id, input, { name: "r.png", data: PNG });
    const b = await submitExpense(driver, id, input, { name: "r.png", data: PNG });
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    expect(await admin.db.select().from(tripExpenses).where(eq(tripExpenses.tripId, id))).toHaveLength(1);
  });

  it("a reviewer decides who bears it (defaulting from the fuel/toll terms), rejection needs a reason, and a decision is final", async () => {
    const included = await readyTrip({ fuelIncluded: true });
    const e1 = await submitExpense(driver, included, expense({ category: "fuel" }), { name: "r.png", data: PNG });
    expect(await reviewExpense(accountant, e1.id, { decision: "approve" })).toEqual({ status: "approved", companyBears: false }); // payout already includes fuel
    const e2 = await submitExpense(driver, included, expense({ category: "fuel" }), { name: "r.png", data: PNG });
    expect(await reviewExpense(accountant, e2.id, { decision: "approve", companyBears: true })).toMatchObject({ companyBears: true }); // reviewer overrides
    const e3 = await submitExpense(driver, included, expense({ category: "repair" }), { name: "r.png", data: PNG });
    await expect(reviewExpense(accountant, e3.id, { decision: "reject" })).rejects.toMatchObject({ status: 400 });
    expect(await reviewExpense(accountant, e3.id, { decision: "reject", note: "Personal repair" })).toEqual({ status: "rejected", companyBears: false });
    await expect(reviewExpense(owner, e3.id, { decision: "approve" })).rejects.toMatchObject({ status: 409 });
    await expect(reviewExpense(dispatcher, e1.id, { decision: "approve" })).rejects.toThrow(/Forbidden/);
    await expect(reviewExpense(driver, e1.id, { decision: "approve" })).rejects.toThrow(/Forbidden/);
    // evidence and amounts are fixed
    await expect(withTenant(owner.tenantId, owner.userId, (db) => db.update(tripExpenses).set({ amountCentavos: 1 }))).rejects.toThrow();
    await expect(admin.db.update(tripExpenses).set({ amountCentavos: 1 }).where(eq(tripExpenses.id, e1.id))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/fixed once submitted/) } });
    await expect(admin.db.update(tripExpenses).set({ status: "approved" }).where(eq(tripExpenses.id, e3.id))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/cannot be changed/) } });
    expect((await listExpensesToReview(accountant)).map((x) => x.id)).not.toContain(e1.id);
  });

  it("office staff can enter a company-paid expense, which counts immediately", async () => {
    const id = await openTrip();
    const r = await addCompanyExpense(dispatcher, id, expense({ category: "toll", amountCentavos: 80_000 }), null);
    const [row] = await admin.db.select().from(tripExpenses).where(eq(tripExpenses.id, r.id));
    expect(row).toMatchObject({ status: "approved", companyBears: true, paidByDriverId: null });
    await expect(addCompanyExpense(driver, id, expense(), null)).rejects.toThrow(/Forbidden/);
  });
});

describe("trip profit and who may see it", () => {
  it("profit = customer charge - partner payout - approved company-borne expenses, with driver pay kept separate", async () => {
    const t = await readyTrip({ partner: true, rate: 10_000_000, payout: 7_000_000 });
    await addCompanyExpense(accountant, t, expense({ category: "toll", amountCentavos: 300_000 }), null);
    await addCompanyExpense(accountant, t, expense({ category: "parking", amountCentavos: 200_000 }), null);
    const pending = await openTrip(); // unrelated trip so a submitted expense exists elsewhere
    await submitExpense(driver, pending, expense({ amountCentavos: 999_999 }), { name: "r.png", data: PNG });

    const f = await tripFinancials(accountant, t);
    expect(f.assignedTo).toBe("partner");
    expect(f.profit).toMatchObject({ revenueCentavos: 10_000_000, partnerPayoutCentavos: 7_000_000, driverPayCentavos: 0, directExpensesCentavos: 500_000, profitCentavos: 2_500_000, marginBps: 2500 });
    expect(f.expenses).toHaveLength(2);

    const internal = await readyTrip({ rate: 5_000_000, payout: 1_400_000 });
    const g = await tripFinancials(owner, internal);
    expect(g.assignedTo).toBe("internal");
    expect(g.profit).toMatchObject({ partnerPayoutCentavos: 0, driverPayCentavos: 1_400_000, profitCentavos: 3_600_000 });
  });

  it("an unapproved or someone-else's expense never reduces profit", async () => {
    const t = await readyTrip({ rate: 2_000_000, payout: 1_000_000 });
    const e = await submitExpense(driver, t, expense({ amountCentavos: 400_000 }), { name: "r.png", data: PNG });
    expect((await tripFinancials(accountant, t)).profit).toMatchObject({ directExpensesCentavos: 0, pendingExpensesCentavos: 400_000, profitCentavos: 1_000_000 });
    await reviewExpense(accountant, e.id, { decision: "approve", companyBears: false });
    expect((await tripFinancials(accountant, t)).profit.profitCentavos).toBe(1_000_000);
    const e2 = await submitExpense(driver, t, expense({ amountCentavos: 100_000, category: "repair" }), { name: "r.png", data: PNG });
    await reviewExpense(accountant, e2.id, { decision: "approve" });
    expect((await tripFinancials(accountant, t)).profit.profitCentavos).toBe(900_000);
  });

  it("the summary totals the finished trips, and shows invoice and settlement status", async () => {
    const t = await readyTrip({ partner: true, rate: 3_000_000, payout: 2_000_000 });
    await generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: key() });
    const s = await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [t], idempotencyKey: key() });
    const summary = await profitSummary(accountant);
    const row = summary.items.find((i) => i.tripId === t)!;
    expect(row.invoice?.number).toMatch(/^INV-/);
    expect(row.settlement).toMatchObject({ id: s.id, status: "issued" });
    expect(summary.totals.revenueCentavos).toBe(summary.items.reduce((n, i) => n + i.profit.revenueCentavos, 0));
    expect(summary.totals.profitCentavos).toBe(summary.items.reduce((n, i) => n + i.profit.profitCentavos, 0));
    const open = await openTrip();
    expect((await profitSummary(accountant)).items.map((i) => i.tripId)).not.toContain(open);
    expect((await profitSummary(accountant, { onlyCompleted: false })).items.map((i) => i.tripId)).toContain(open);
  });

  it("only owners, ops managers and accountants see profit; dispatch, drivers and partners get nothing", async () => {
    const t = await readyTrip();
    await expect(tripFinancials(dispatcher, t)).rejects.toThrow(/Forbidden/);
    await expect(profitSummary(dispatcher)).rejects.toThrow(/Forbidden/);
    await expect(tripFinancials(driver, t)).rejects.toThrow(/Forbidden/);
    await expect(profitSummary(partnerOwner)).rejects.toThrow(/Forbidden/);
    await expect(tripFinancials(await actorFor("owner@bayan.test"), t)).rejects.toMatchObject({ status: 404 });
    const ops = { ...(await actorFor("owner@acme.test")), role: "ops_manager" as const };
    expect((await tripFinancials(ops, t)).profit.revenueCentavos).toBe(1_850_000);
  });
});

describe("driver earnings", () => {
  it("shows a driver their own payouts and reimbursements, and nothing about the customer rate or other drivers", async () => {
    const t = await readyTrip({ rate: 6_543_210, payout: 1_234_500 });
    const e = await submitExpense(driver, t, expense({ category: "toll", amountCentavos: 55_000 }), { name: "r.png", data: PNG });
    await reviewExpense(accountant, e.id, { decision: "approve" });
    const mine = await driverEarnings(driver);
    const row = mine.trips.find((x) => x.tripId === t)!;
    expect(row).toMatchObject({ payoutCentavos: 1_234_500, earned: true });
    expect(mine.earnedCentavos).toBeGreaterThanOrEqual(1_234_500);
    expect(mine.reimbursementsCentavos).toBeGreaterThanOrEqual(55_000);
    expect(JSON.stringify(mine)).not.toMatch(/contract|6543210|profit|margin/i);
    expect((await driverEarnings(opsDriver)).trips.map((x) => x.tripId)).not.toContain(t);
    await expect(driverEarnings(partnerDriver)).rejects.toThrow(/Forbidden/);
    await expect(driverEarnings(accountant)).rejects.toThrow(/Forbidden/);
  });
});

describe("finance rows are private to the company", () => {
  it("other companies see no invoices, settlements, expenses or counters", async () => {
    const t = await readyTrip({ partner: true });
    await generateInvoice(accountant, { customerId: customerA, tripIds: [t], idempotencyKey: key() });
    await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [t], idempotencyKey: key() });
    const s = (await import("@/server/db/schema"));
    for (const table of [s.invoices, s.invoiceLines, s.settlements, s.settlementLines, s.tripExpenses, s.documentCounters]) {
      expect(await withTenant(bayanOwner.tenantId, bayanOwner.userId, (db) => db.select().from(table))).toEqual([]);
    }
    expect(await withTenant(driver.tenantId, driver.userId, (db) => db.select().from(s.invoices))).not.toEqual([]); // company context does see them
  });
});
