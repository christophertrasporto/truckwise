import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/server/db";
import { memberships, subconApplications, trucks, users, companyExpenses } from "@/server/db/schema";
import { addCost, costLedger, voidCost } from "@/server/services/finance/costs";
import { companyForToken, getApplication, getApplyToken, listApplications, reviewApplication, submitApplication, type ApplicationFile } from "@/server/services/applications";
import { PHOTO_KINDS, applicationInput } from "@/shared/application";
import type { TenantActor } from "@/server/services/trips";
import { PNG, actorFor, admin } from "../helpers";

let owner: TenantActor, dispatcher: TenantActor, accountant: TenantActor, bayanOwner: TenantActor, partnerOwner: TenantActor;
let n = 0;
const uid = () => `k-${Date.now()}-${n++}-${Math.random().toString(36).slice(2, 8)}`;
const MONTH = "2031-05";

beforeAll(async () => {
  owner = await actorFor("owner@acme.test");
  dispatcher = await actorFor("dispatcher@acme.test");
  accountant = await actorFor("accountant@acme.test");
  bayanOwner = await actorFor("owner@bayan.test");
  partnerOwner = await actorFor("owner@santos.test");
});
afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

describe("company cost ledger", () => {
  it("records, totals, and voids costs, and is idempotent", async () => {
    const key = uid();
    const input = { category: "diesel" as const, amountCentavos: 4_500_00, incurredOn: `${MONTH}-10`, idempotencyKey: key };
    const a = await addCost(owner, input);
    const again = await addCost(owner, input);
    expect(again.id).toBe(a.id);
    expect(again.duplicate).toBe(true);
    await addCost(owner, { category: "rfid", amountCentavos: 500_00, incurredOn: `${MONTH}-11`, idempotencyKey: uid() });

    const ledger = await costLedger(owner, { month: MONTH });
    expect(ledger.totalCentavos).toBe(5_000_00);
    expect(ledger.byCategory.map((c) => c.category).sort()).toEqual(["diesel", "rfid"]);

    await voidCost(owner, a.id, "entered twice by mistake");
    const after = await costLedger(owner, { month: MONTH });
    expect(after.totalCentavos).toBe(500_00);
    expect(after.rows.find((r) => r.id === a.id)?.voided).toBe(true);
    await expect(voidCost(owner, a.id, "again please")).rejects.toMatchObject({ status: 409 });
  });

  it("keeps salaries to the owner and accountant", async () => {
    await expect(addCost(dispatcher, { category: "salary", amountCentavos: 1_000_00, incurredOn: `${MONTH}-12`, idempotencyKey: uid() })).rejects.toThrow();
    const s = await addCost(accountant, { category: "salary", amountCentavos: 12_000_00, incurredOn: `${MONTH}-12`, idempotencyKey: uid() });
    expect((await costLedger(accountant, { month: MONTH })).rows.some((r) => r.id === s.id)).toBe(true);
    expect((await costLedger(owner, { month: MONTH })).rows.some((r) => r.id === s.id)).toBe(true);
  });

  it("is invisible to other companies, and rejects another company's truck", async () => {
    const [foreign] = await admin.db.select().from(trucks).where(eq(trucks.tenantId, partnerOwner.tenantId));
    await expect(addCost(owner, { category: "tires", amountCentavos: 100_00, incurredOn: `${MONTH}-13`, truckId: foreign.id, idempotencyKey: uid() })).rejects.toMatchObject({ status: 400 });
    expect((await costLedger(bayanOwner, { month: MONTH })).totalCentavos).toBe(0);
  });

  it("cannot be edited or deleted after it is recorded", async () => {
    const c = await addCost(owner, { category: "toll", amountCentavos: 200_00, incurredOn: `${MONTH}-14`, idempotencyKey: uid() });
    await expect(admin.db.update(companyExpenses).set({ amountCentavos: 1 }).where(eq(companyExpenses.id, c.id))).rejects.toThrow();
    await expect(admin.db.delete(companyExpenses).where(eq(companyExpenses.id, c.id))).rejects.toThrow();
  });
});

const goodInput = (over: Record<string, unknown> = {}) =>
  applicationInput.parse({
    companyName: "Reyes Hauling",
    contactName: "Pedro Reyes",
    phone: "0917 123 4567",
    email: `pedro-${uid()}@example.com`,
    plateNumber: `ZZ${Math.floor(Math.random() * 9000 + 1000)}`,
    truckType: "10-wheeler",
    truckSize: "14ft",
    driverName: "Pedro Reyes",
    ...over,
  });
const photos = (skip?: string): ApplicationFile[] => PHOTO_KINDS.filter((k) => k !== skip).map((kind) => ({ kind, name: `${kind}.png`, data: PNG }));
let ipN = 0;
const ip = () => `10.1.${Math.floor(ipN / 200)}.${ipN++ % 200}`;

describe("subcontractor applications", () => {
  it("builds an application link only the company can resolve", async () => {
    const t = await getApplyToken(owner);
    expect(await getApplyToken(owner)).toBe(t);
    expect(await companyForToken(t)).toEqual({ tenantId: owner.tenantId });
    expect(await companyForToken("not-a-real-token-at-all-xx")).toBeNull();
  });

  it("accepts a complete application, then staff review it and approval creates the company, login and truck", async () => {
    const token = await getApplyToken(owner);
    const input = goodInput();
    const res = await submitApplication(token, input, photos(), { ip: ip() });
    expect(res.id).toBeTruthy();

    const list = await listApplications(owner, "new");
    expect(list.some((a) => a.id === res.id)).toBe(true);
    const detail = await getApplication(owner, res.id!);
    expect(detail.photos).toHaveLength(6);
    expect(detail.photos.every((p) => p.url)).toBe(true);

    // another trucking company cannot see it
    expect((await listApplications(bayanOwner)).some((a) => a.id === res.id)).toBe(false);
    await expect(getApplication(bayanOwner, res.id!)).rejects.toMatchObject({ status: 404 });
    // a dispatcher cannot decide
    await expect(reviewApplication(dispatcher, res.id!, { decision: "approve" })).rejects.toThrow();

    const approved = await reviewApplication(owner, res.id!, { decision: "approve" });
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") return;
    expect(approved.temporaryPassword).toHaveLength(12);
    const [u] = await admin.db.select().from(users).where(eq(users.email, input.email));
    const [m] = await admin.db.select().from(memberships).where(eq(memberships.userId, u.id));
    expect(m.role).toBe("sub_owner");
    const [truck] = await admin.db.select().from(trucks).where(eq(trucks.tenantId, approved.partnerTenantId));
    expect(truck.plate).toBe(input.plateNumber);
    await expect(reviewApplication(owner, res.id!, { decision: "reject", note: "late" })).rejects.toMatchObject({ status: 409 });
  });

  it("requires a reason to reject", async () => {
    const token = await getApplyToken(owner);
    const res = await submitApplication(token, goodInput(), photos(), { ip: ip() });
    await expect(reviewApplication(owner, res.id!, { decision: "reject" })).rejects.toMatchObject({ status: 400 });
    expect((await reviewApplication(owner, res.id!, { decision: "reject", note: "Photos too dark" })).status).toBe("rejected");
  });

  it("refuses a missing photo, a non-image, an unknown link, and a duplicate plate", async () => {
    const token = await getApplyToken(owner);
    await expect(submitApplication(token, goodInput(), photos("license"), { ip: ip() })).rejects.toMatchObject({ status: 400 });
    const fake = photos().map((f) => (f.kind === "front" ? { ...f, data: Buffer.from("<script>alert(1)</script>") } : f));
    await expect(submitApplication(token, goodInput(), fake, { ip: ip() })).rejects.toMatchObject({ status: 400 });
    await expect(submitApplication("x".repeat(24), goodInput(), photos(), { ip: ip() })).rejects.toMatchObject({ status: 404 });

    const plate = `DUP${Math.floor(Math.random() * 9000 + 1000)}`;
    await submitApplication(token, goodInput({ plateNumber: plate }), photos(), { ip: ip() });
    await expect(submitApplication(token, goodInput({ plateNumber: plate }), photos(), { ip: ip() })).rejects.toMatchObject({ status: 409 });
  });

  it("looks successful but stores nothing when the hidden field is filled", async () => {
    const token = await getApplyToken(owner);
    const input = goodInput({ website: "http://spam.example" });
    const res = await submitApplication(token, input, photos(), { ip: ip() });
    expect(res.id).toBeNull();
    const rows = await admin.db.select().from(subconApplications).where(eq(subconApplications.email, input.email));
    expect(rows).toHaveLength(0);
  });

  it("limits repeat applications per email and per connection", async () => {
    const token = await getApplyToken(owner);
    const email = `repeat-${uid()}@example.com`;
    for (let i = 0; i < 3; i++) await submitApplication(token, goodInput({ email, plateNumber: `RPT${i}${Math.floor(Math.random() * 900 + 100)}` }), photos(), { ip: ip() });
    await expect(submitApplication(token, goodInput({ email }), photos(), { ip: ip() })).rejects.toMatchObject({ status: 429 });

    const same = ip();
    for (let i = 0; i < 6; i++) await submitApplication(token, goodInput({ plateNumber: `IPL${i}${Math.floor(Math.random() * 900 + 100)}` }), photos(), { ip: same });
    await expect(submitApplication(token, goodInput(), photos(), { ip: same })).rejects.toMatchObject({ status: 429 });
  });

  it("takes several trucks, each with its own photos, and approval puts every truck on the new fleet", async () => {
    const token = await getApplyToken(owner);
    const p2 = `TWO${Math.floor(Math.random() * 9000 + 1000)}`;
    const p3 = `TRE${Math.floor(Math.random() * 9000 + 1000)}`;
    const input = goodInput({
      extraTrucks: [
        { plateNumber: p2, truckType: "6-wheeler", truckSize: "12ft", driverName: "Driver Two" },
        { plateNumber: p3, truckType: "Other", truckTypeOther: "Dump truck", truckSize: "Other", truckSizeOther: "22ft", driverName: "Driver Three" },
      ],
    });
    const all = [0, 1, 2].flatMap((truck) => photos().map((f) => ({ ...f, truck })));
    // the second truck is missing a photo: refused, and it names the truck
    const short = all.filter((f) => !(f.truck === 1 && f.kind === "back"));
    await expect(submitApplication(token, input, short, { ip: ip() })).rejects.toMatchObject({ status: 400, message: expect.stringContaining(p2) });

    const res = await submitApplication(token, input, all, { ip: ip() });
    expect((await listApplications(owner)).find((a) => a.id === res.id)?.truckCount).toBe(3);
    const detail = await getApplication(owner, res.id!);
    expect(detail.trucks.map((t) => t.plateNumber)).toEqual([input.plateNumber, p2, p3].sort((a, b) => (a === input.plateNumber ? -1 : b === input.plateNumber ? 1 : a.localeCompare(b))));
    expect(detail.trucks.every((t) => t.photos.length === 6 && t.photos.every((p) => p.url))).toBe(true);
    expect(detail.trucks.find((t) => t.plateNumber === p3)?.truckType).toBe("Other: Dump truck");

    // one of the extra plates is already waiting for review
    await expect(submitApplication(token, goodInput({ plateNumber: p2 }), photos(), { ip: ip() })).rejects.toMatchObject({ status: 409 });

    const approved = await reviewApplication(owner, res.id!, { decision: "approve" });
    if (approved.status !== "approved") throw new Error("expected approval");
    const fleet = await admin.db.select().from(trucks).where(eq(trucks.tenantId, approved.partnerTenantId));
    expect(fleet.map((t) => t.plate).sort()).toEqual([input.plateNumber, p2, p3].sort());
    expect(fleet.find((t) => t.plate === p3)?.truckType).toBe("Dump truck");
  });

  it("rejects an application that repeats a plate", () => {
    expect(() => goodInput({ plateNumber: "SAME1234", extraTrucks: [{ plateNumber: "SAME1234", truckType: "6-wheeler", truckSize: "12ft", driverName: "X" }] })).toThrow();
  });

  it("validates the form fields", () => {
    expect(() => goodInput({ phone: "12345" })).toThrow();
    expect(() => goodInput({ truckType: "Other" })).toThrow(); // "Other" needs a description
    expect(goodInput({ truckType: "Other", truckTypeOther: "Dump truck" }).truckTypeOther).toBe("Dump truck");
    expect(() => goodInput({ truckSize: "Other" })).toThrow();
  });
});
