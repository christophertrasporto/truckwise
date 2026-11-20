import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/server/db";
import { companyIncome, customers } from "@/server/db/schema";
import { addIncome, incomeLedger, voidIncome } from "@/server/services/finance/income";
import type { TenantActor } from "@/server/services/trips";
import { actorFor, admin } from "../helpers";

let owner: TenantActor, accountant: TenantActor, dispatcher: TenantActor, bayanOwner: TenantActor;
let clientA: string, clientB: string, bayanClient: string;
let n = 0;
const key = () => `inc-${Date.now()}-${n++}-${Math.random().toString(36).slice(2, 8)}`;
const MONTH = "2032-03";

beforeAll(async () => {
  owner = await actorFor("owner@acme.test");
  accountant = await actorFor("accountant@acme.test");
  dispatcher = await actorFor("dispatcher@acme.test");
  bayanOwner = await actorFor("owner@bayan.test");
  [{ id: clientA }] = await admin.db.insert(customers).values({ tenantId: owner.tenantId, name: `Income A ${key()}` }).returning();
  [{ id: clientB }] = await admin.db.insert(customers).values({ tenantId: owner.tenantId, name: `Income B ${key()}` }).returning();
  [{ id: bayanClient }] = await admin.db.insert(customers).values({ tenantId: bayanOwner.tenantId, name: `Bayan ${key()}` }).returning();
});
afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

describe("income received from clients", () => {
  it("records payments by client, totals them, and is idempotent", async () => {
    const k = key();
    const a = await addIncome(owner, { customerId: clientA, amountCentavos: 52_600_00, receivedOn: `${MONTH}-02`, note: "Weekly payment", idempotencyKey: k });
    expect((await addIncome(owner, { customerId: clientA, amountCentavos: 52_600_00, receivedOn: `${MONTH}-02`, idempotencyKey: k })).duplicate).toBe(true);
    await addIncome(accountant, { customerId: clientB, amountCentavos: 10_000_00, receivedOn: `${MONTH}-09`, idempotencyKey: key() });
    const ledger = await incomeLedger(owner, { month: MONTH });
    expect(ledger.totalCentavos).toBe(62_600_00);
    expect(ledger.byClient.map((c) => c.amountCentavos)).toEqual([52_600_00, 10_000_00]);
    expect((await incomeLedger(owner, { month: MONTH, customerId: clientB })).totalCentavos).toBe(10_000_00);

    await voidIncome(owner, a.id, "entered twice by mistake");
    expect((await incomeLedger(owner, { month: MONTH })).totalCentavos).toBe(10_000_00);
    await expect(voidIncome(owner, a.id, "again please")).rejects.toMatchObject({ status: 409 });
  });

  it("is for the owner and accountant only", async () => {
    await expect(addIncome(dispatcher, { customerId: clientA, amountCentavos: 100, receivedOn: `${MONTH}-10`, idempotencyKey: key() })).rejects.toThrow(/Forbidden/);
    await expect(incomeLedger(dispatcher, { month: MONTH })).rejects.toThrow(/Forbidden/);
  });

  it("keeps companies apart", async () => {
    await expect(addIncome(owner, { customerId: bayanClient, amountCentavos: 100, receivedOn: `${MONTH}-11`, idempotencyKey: key() })).rejects.toMatchObject({ status: 400 });
    expect((await incomeLedger(bayanOwner, { month: MONTH })).totalCentavos).toBe(0);
  });

  it("cannot be edited or deleted once recorded", async () => {
    const r = await addIncome(owner, { customerId: clientA, amountCentavos: 500_00, receivedOn: `${MONTH}-12`, idempotencyKey: key() });
    await expect(admin.db.update(companyIncome).set({ amountCentavos: 1 }).where(eq(companyIncome.id, r.id))).rejects.toThrow();
    await expect(admin.db.delete(companyIncome).where(eq(companyIncome.id, r.id))).rejects.toThrow();
  });
});
