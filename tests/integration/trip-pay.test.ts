import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/server/db";
import { auditLog, customers, settlementLines, trips } from "@/server/db/schema";
import { updateTripMoney } from "@/server/services/finance/money";
import { tripFinancials } from "@/server/services/finance/profit";
import { generateSettlement } from "@/server/services/finance/settlements";
import { claimTrip, createOffer } from "@/server/services/offers";
import { getTripForPartner, listPartnerBoard, partnerAccept } from "@/server/services/partner";
import { reviewPod, submitPod } from "@/server/services/pod";
import { updateSettings } from "@/server/services/settings";
import { advanceTrip, createTrip, type TenantActor } from "@/server/services/trips";
import { computeProfit } from "@/shared/finance";
import { PNG, actorFor, admin, drain, tripInput, truckIdOf } from "../helpers";

let owner: TenantActor, dispatcher: TenantActor, accountant: TenantActor, driver: TenantActor, partnerOwner: TenantActor, partnerDriver: TenantActor;
let customerId: string, acmeTruck: string, partnerTruck: string;
let n = 0;
const key = () => `pay-${Date.now()}-${n++}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  owner = await actorFor("owner@acme.test");
  dispatcher = await actorFor("dispatcher@acme.test");
  accountant = await actorFor("accountant@acme.test");
  driver = await actorFor("driver@acme.test");
  partnerOwner = await actorFor("owner@santos.test");
  partnerDriver = await actorFor("driver@santos.test");
  acmeTruck = await truckIdOf(owner.tenantId, "ACM-101");
  partnerTruck = await truckIdOf(partnerOwner.tenantId, "STS-201");
  const [c] = await admin.db.insert(customers).values({ tenantId: owner.tenantId, name: `Pay Client ${key()}` }).returning();
  customerId = c.id;
  await updateSettings(owner, { claimMode: "immediate", podAutoApprove: false, vatBps: 0 });
});
afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

const RATE = 2_000_000; // customer pays 20,000
const DRIVER = 1_200_000; // own driver 12,000
const SUB = 1_500_000; // subcontractor 15,000
const HELPER = 100_000; // helper 1,000

/** Everything on the partner board, direct offers and broadcasts together. */
const boardOf = async (a: TenantActor) => {
  const b = await listPartnerBoard(a);
  return [...b.direct, ...b.broadcast];
};
const newTrip = () => createTrip(dispatcher, tripInput(customerId, { contractRateCentavos: RATE, payoutCentavos: DRIVER, subcontractorPayoutCentavos: SUB, helperPayCentavos: HELPER }));

async function finish(id: string, worker: TenantActor) {
  for (const to of ["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"] as const) await advanceTrip(worker, id, to);
  const r = await submitPod(worker, id, { outcome: "complete", receiverName: "Maria", actualDeliveryAt: new Date(Date.now() - 3600_000).toISOString(), gpsConsent: "unavailable", idempotencyKey: key() }, [{ name: "r.png", data: PNG }, { name: "s.png", data: PNG, kind: "signature" }]);
  await drain();
  await reviewPod(dispatcher, r.submissionId, { decision: "approve" });
}

describe("profit with helper pay", () => {
  it("charges the helper to own-truck trips only", () => {
    const base = { revenueCentavos: RATE, payoutCentavos: DRIVER, helperPayCentavos: HELPER, expenses: [] };
    const own = computeProfit({ ...base, assignedTo: "internal" });
    expect(own.helperPayCentavos).toBe(HELPER);
    expect(own.profitCentavos).toBe(RATE - DRIVER - HELPER);
    const sub = computeProfit({ ...base, payoutCentavos: SUB, assignedTo: "partner" });
    expect(sub.helperPayCentavos).toBe(0);
    expect(sub.profitCentavos).toBe(RATE - SUB);
    expect(computeProfit({ revenueCentavos: RATE, payoutCentavos: DRIVER, assignedTo: "internal", expenses: [] }).helperPayCentavos).toBe(0);
  });
});

describe("a separate subcontractor rate and helper pay", () => {
  it("shows a subcontractor its own rate and a driver the driver pay, never the other", async () => {
    const { id } = await newTrip();
    await createOffer(dispatcher, id, { mode: "broadcast_all" });
    const board = await boardOf(partnerOwner);
    const row = board.find((t) => t.id === id)!;
    expect(row.payoutCentavos).toBe(SUB);
    expect(JSON.stringify(board.find((t) => t.id === id))).not.toContain(String(DRIVER));
    expect(JSON.stringify(row)).not.toContain("helperPay");
    expect(JSON.stringify(row)).not.toContain(String(RATE));

    // the company's own driver sees the driver pay
    const claimed = await claimTrip(driver, id, { truckId: acmeTruck });
    expect(claimed).toBeTruthy();
  });

  it("pays a subcontractor the subcontractor rate on the trip, the profit and the settlement", async () => {
    const { id } = await newTrip();
    await createOffer(dispatcher, id, { mode: "broadcast_partners" });
    await partnerAccept(partnerOwner, owner.tenantId, id, { truckId: partnerTruck, driverUserId: partnerDriver.userId });
    expect((await getTripForPartner(partnerOwner, owner.tenantId, id)).trip.payoutCentavos).toBe(SUB);
    await finish(id, partnerDriver);

    const fin = await tripFinancials(accountant, id);
    expect(fin.profit.partnerPayoutCentavos).toBe(SUB);
    expect(fin.profit.helperPayCentavos).toBe(0);
    expect(fin.profit.profitCentavos).toBe(RATE - SUB);

    const s = await generateSettlement(accountant, { partnerTenantId: partnerOwner.tenantId, tripIds: [id], idempotencyKey: key() });
    const lines = await admin.db.select().from(settlementLines).where(eq(settlementLines.settlementId, s.id));
    expect(lines.map((l) => l.amountCentavos)).toEqual([SUB]);
  });

  it("uses the driver pay and the helper on a trip done by the company's own driver", async () => {
    const { id } = await newTrip();
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
    await finish(id, driver);
    const fin = await tripFinancials(accountant, id);
    expect(fin.profit.driverPayCentavos).toBe(DRIVER);
    expect(fin.profit.helperPayCentavos).toBe(HELPER);
    expect(fin.profit.profitCentavos).toBe(RATE - DRIVER - HELPER);
  });

  it("falls back to the driver pay when no subcontractor rate was set", async () => {
    const { id } = await createTrip(dispatcher, tripInput(customerId, { contractRateCentavos: RATE, payoutCentavos: DRIVER }));
    await createOffer(dispatcher, id, { mode: "broadcast_partners" });
    expect((await boardOf(partnerOwner)).find((t) => t.id === id)?.payoutCentavos).toBe(DRIVER);
  });

  it("records changes to the new pay fields with old and new values, and refuses them to other roles", async () => {
    const { id } = await newTrip();
    await expect(updateTripMoney(dispatcher, id, { helperPayCentavos: 5 * 100_000, reason: "more" })).rejects.toThrow(/Forbidden/);
    await updateTripMoney(accountant, id, { subcontractorPayoutCentavos: 1_600_000, helperPayCentavos: 150_000, reason: "Longer route agreed" });
    const [t] = await admin.db.select().from(trips).where(eq(trips.id, id));
    expect([t.subcontractorPayoutCentavos, t.helperPayCentavos]).toEqual([1_600_000, 150_000]);
    const audit = (await admin.db.select().from(auditLog).where(eq(auditLog.entityId, id))).find((a) => a.action === "trip.money")!;
    expect(audit.oldValue).toMatchObject({ subcontractorPayoutCentavos: SUB, helperPayCentavos: HELPER });
    expect(audit.newValue).toMatchObject({ subcontractorPayoutCentavos: 1_600_000, helperPayCentavos: 150_000, reason: "Longer route agreed" });
    // clearing the subcontractor rate goes back to the driver pay
    await updateTripMoney(accountant, id, { subcontractorPayoutCentavos: null, reason: "Same as the driver now" });
    expect((await admin.db.select().from(trips).where(eq(trips.id, id)))[0].subcontractorPayoutCentavos).toBeNull();
  });
});
