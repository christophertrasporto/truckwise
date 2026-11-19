import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/server/db";
import { auditLog, jobs, subscriptionPayments, subscriptions, tenants, users } from "@/server/db/schema";
import {
  addMonths,
  changePlan,
  createCompany,
  createPlan,
  getCompany,
  listCompanies,
  platformActivity,
  platformDashboard,
  recordPayment,
  runSubscriptionSweep,
  setCompanyStatus,
  updatePlan,
} from "@/server/services/admin";
import { companyForToken, getApplyToken } from "@/server/services/applications";
import { suspendedCompaniesFor } from "@/server/services/entitlements";
import { addCost } from "@/server/services/finance/costs";
import { addTruck } from "@/server/services/fleet";
import { addMember } from "@/server/services/members";
import { PLAN_FEATURES, type PlanInput } from "@/shared/plans";
import type { Actor } from "@/server/policy";
import type { TenantActor } from "@/server/services/trips";
import { actorFor, admin } from "../helpers";

let platformAdmin: Actor, acmeOwner: TenantActor;
let n = 0;
const uid = () => `p-${Date.now()}-${n++}-${Math.random().toString(36).slice(2, 8)}`;
const features = (on: boolean) => Object.fromEntries(PLAN_FEATURES.map((f) => [f.key, on])) as PlanInput["features"];

const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
  name: `Plan ${uid()}`,
  priceCentavos: 1_500_00,
  periodMonths: 1,
  maxTrucks: null,
  maxDrivers: null,
  maxUsers: null,
  features: features(true),
  active: true,
  ...over,
});

/** A trucking company on a plan, with its owner signed in as an actor. */
async function company(over: Partial<PlanInput> = {}, trialDays = 14) {
  const { id: planId } = await createPlan(platformAdmin, plan(over));
  const email = `owner-${uid()}@example.test`;
  const res = await createCompany(platformAdmin, { companyName: `Co ${uid()}`, ownerName: "Owner", ownerEmail: email, planId, trialDays });
  return { ...res, planId, owner: await actorFor(email) };
}

beforeAll(async () => {
  const [u] = await admin.db.select().from(users).where(eq(users.email, "admin@smartload.test"));
  platformAdmin = { userId: u.id, tenantId: null, tenantKind: null, role: null, isPlatformAdmin: true };
  acmeOwner = await actorFor("owner@acme.test");
});
afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

describe("who may administer the platform", () => {
  it("refuses everything to a company owner", async () => {
    await expect(listCompanies(acmeOwner)).rejects.toThrow();
    await expect(platformDashboard(acmeOwner)).rejects.toThrow();
    await expect(platformActivity(acmeOwner)).rejects.toThrow();
    await expect(createPlan(acmeOwner, plan())).rejects.toThrow();
    await expect(setCompanyStatus(acmeOwner, acmeOwner.tenantId, { status: "suspended", reason: "no way" })).rejects.toThrow();
  });
});

describe("plans and companies", () => {
  it("creates a company with an owner login and a trial, and refuses a duplicate plan name", async () => {
    const c = await company();
    expect(c.temporaryPassword).toHaveLength(12);
    const detail = await getCompany(platformAdmin, c.tenantId);
    expect(detail.subscription?.status).toBe("trialing");
    expect(detail.owners[0].email).toBe(c.ownerEmail);
    expect(c.owner.role).toBe("owner");
    const p = plan({ name: `Dup ${uid()}` });
    await createPlan(platformAdmin, p);
    await expect(createPlan(platformAdmin, p)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an inactive plan for a new company", async () => {
    const { id } = await createPlan(platformAdmin, plan({ active: false }));
    await expect(createCompany(platformAdmin, { companyName: "X Co", ownerName: "Xavier", ownerEmail: `x-${uid()}@example.test`, planId: id, trialDays: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it("keeps a company out of other companies' subscriptions", async () => {
    const a = await company();
    const b = await company();
    const seen = await withTenant(a.tenantId, a.owner.userId, (db) => db.select().from(subscriptions));
    expect(seen.map((s) => s.tenantId)).toEqual([a.tenantId]);
    expect(seen.some((s) => s.tenantId === b.tenantId)).toBe(false);
    // and a company cannot write its own subscription
    await expect(withTenant(a.tenantId, a.owner.userId, (db) => db.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.tenantId, a.tenantId)).returning())).resolves.toHaveLength(0);
  });
});

describe("plan limits and feature flags are enforced on the server", () => {
  it("stops adding trucks past the plan, and lets a plan change lift the limit at once", async () => {
    const c = await company({ maxTrucks: 1 });
    const truck = (plate: string) => ({ plate, truckType: "10-wheeler" as const, capacityKg: 10_000 });
    await addTruck(c.owner, truck(`LIM${Math.floor(Math.random() * 9000 + 1000)}`));
    await expect(addTruck(c.owner, truck(`LIM${Math.floor(Math.random() * 9000 + 1000)}`))).rejects.toMatchObject({ status: 402 });
    const bigger = await createPlan(platformAdmin, plan({ maxTrucks: 5 }));
    await changePlan(platformAdmin, c.tenantId, { planId: bigger.id });
    await addTruck(c.owner, truck(`LIM${Math.floor(Math.random() * 9000 + 1000)}`));
  });

  it("limits people and drivers", async () => {
    const c = await company({ maxUsers: 2, maxDrivers: 1 }); // the owner already counts as one person
    const member = (role: "driver" | "dispatcher") => ({ name: "Person", email: `m-${uid()}@example.test`, password: "a-long-password-1", role });
    await addMember(c.owner, member("driver"));
    await expect(addMember(c.owner, member("dispatcher"))).rejects.toMatchObject({ status: 402 }); // 3 people on a 2-person plan
    const c2 = await company({ maxUsers: 10, maxDrivers: 1 });
    await addMember(c2.owner, member("driver"));
    await expect(addMember(c2.owner, member("driver"))).rejects.toMatchObject({ status: 402 });
    await addMember(c2.owner, member("dispatcher")); // not a driver, so still fine
  });

  it("switches features off for a plan, and back on when the plan is edited", async () => {
    const c = await company({ features: { ...features(true), costs: false, applications: false } });
    const cost = { category: "diesel" as const, amountCentavos: 100_00, incurredOn: "2031-06-01", idempotencyKey: uid() };
    await expect(addCost(c.owner, cost)).rejects.toMatchObject({ status: 402 });
    await expect(getApplyToken(c.owner)).rejects.toMatchObject({ status: 402 });

    const [p] = await admin.db.select().from(subscriptions).where(eq(subscriptions.tenantId, c.tenantId));
    await updatePlan(platformAdmin, p.planId, { ...plan({ name: `Edited ${uid()}` }), features: features(true) });
    await addCost(c.owner, { ...cost, idempotencyKey: uid() });
    const token = await getApplyToken(c.owner);
    expect(await companyForToken(token)).toEqual({ tenantId: c.tenantId });
  });

  it("does not limit a company that has no subscription (the operator's own company)", async () => {
    const [sub] = await admin.db.select().from(subscriptions).where(eq(subscriptions.tenantId, acmeOwner.tenantId));
    expect(sub).toBeUndefined();
    await addCost(acmeOwner, { category: "diesel", amountCentavos: 100_00, incurredOn: "2031-06-02", idempotencyKey: uid() });
  });
});

describe("subscription payments, expiry and suspension", () => {
  it("adds months without skipping any", () => {
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(addMonths(new Date("2026-11-19T00:00:00Z"), 12).toISOString().slice(0, 10)).toBe("2027-11-19");
  });

  it("records a payment once however many times it is sent, and extends the period", async () => {
    const c = await company({}, 0);
    const [before] = await admin.db.select().from(subscriptions).where(eq(subscriptions.tenantId, c.tenantId));
    const input = { amountCentavos: 1_500_00, paidOn: "2026-11-19", method: "GCash", reference: "GC-1", periodsAdded: 1, idempotencyKey: uid() };
    const first = await recordPayment(platformAdmin, c.tenantId, input);
    const again = await recordPayment(platformAdmin, c.tenantId, input);
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    const rows = await admin.db.select().from(subscriptionPayments).where(eq(subscriptionPayments.tenantId, c.tenantId));
    expect(rows).toHaveLength(1);
    const [after] = await admin.db.select().from(subscriptions).where(eq(subscriptions.tenantId, c.tenantId));
    expect(after.periodEnd.getTime()).toBeGreaterThan(before.periodEnd.getTime());
    expect(after.status).toBe("active");
    // another company cannot reuse the reference
    const other = await company({}, 0);
    await expect(recordPayment(platformAdmin, other.tenantId, input)).rejects.toMatchObject({ status: 409 });
    // payments are evidence
    await expect(admin.db.delete(subscriptionPayments).where(eq(subscriptionPayments.id, first.id))).rejects.toThrow();
  });

  it("expires a lapsed subscription, suspends the company, and a payment brings it back", async () => {
    const c = await company({}, 1);
    const reminders = async () => (await admin.db.select().from(jobs).where(like(jobs.dedupeKey, "ev:subscription.expiring:%"))).filter((j) => (j.payload as { tenantId?: string }).tenantId === c.tenantId);

    // two days before the trial ends: a reminder, once however often the timer runs
    const soon = new Date(Date.now() - 2 * 86_400_000 + 2 * 86_400_000 - 3_600_000);
    await runSubscriptionSweep(soon);
    await runSubscriptionSweep(soon);
    expect(await reminders()).toHaveLength(1);
    expect((await admin.db.select().from(tenants).where(eq(tenants.id, c.tenantId)))[0].status).toBe("active");

    // after the end
    const later = new Date(Date.now() + 3 * 86_400_000);
    const swept = await runSubscriptionSweep(later);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect((await admin.db.select().from(tenants).where(eq(tenants.id, c.tenantId)))[0].status).toBe("suspended");
    expect((await admin.db.select().from(subscriptions).where(eq(subscriptions.tenantId, c.tenantId)))[0].status).toBe("expired");
    expect((await suspendedCompaniesFor(c.owner.userId)).length).toBe(1);

    await recordPayment(platformAdmin, c.tenantId, { amountCentavos: 1_500_00, paidOn: "2026-11-19", periodsAdded: 1, idempotencyKey: uid() });
    expect((await admin.db.select().from(tenants).where(eq(tenants.id, c.tenantId)))[0].status).toBe("active");
    expect((await suspendedCompaniesFor(c.owner.userId)).length).toBe(0);
  });

  it("keeps a company the administrator suspended by hand suspended when it pays", async () => {
    const c = await company({}, 0);
    await setCompanyStatus(platformAdmin, c.tenantId, { status: "suspended", reason: "Chargeback under review" });
    await recordPayment(platformAdmin, c.tenantId, { amountCentavos: 1_500_00, paidOn: "2026-11-19", periodsAdded: 1, idempotencyKey: uid() });
    expect((await admin.db.select().from(tenants).where(eq(tenants.id, c.tenantId)))[0].status).toBe("suspended");
    await setCompanyStatus(platformAdmin, c.tenantId, { status: "active", reason: "Resolved" });
    expect((await admin.db.select().from(tenants).where(eq(tenants.id, c.tenantId)))[0].status).toBe("active");
  });

  it("takes no applications while suspended", async () => {
    const c = await company();
    const token = await getApplyToken(c.owner);
    expect(await companyForToken(token)).not.toBeNull();
    await setCompanyStatus(platformAdmin, c.tenantId, { status: "suspended", reason: "Non-payment" });
    expect(await companyForToken(token)).toBeNull();
  });
});

describe("the platform's own views", () => {
  it("summarises companies and records what the platform did, without any company data", async () => {
    const c = await company({}, 0);
    await recordPayment(platformAdmin, c.tenantId, { amountCentavos: 3_000_00, paidOn: "2026-11-19", periodsAdded: 2, idempotencyKey: uid() });
    const dash = await platformDashboard(platformAdmin);
    expect(dash.haulers).toBeGreaterThanOrEqual(1);
    expect(dash.monthlyRecurringCentavos).toBeGreaterThan(0);
    const list = await listCompanies(platformAdmin);
    const row = list.find((x) => x.id === c.tenantId)!;
    expect(row).toMatchObject({ users: 1, trucks: 0, subscriptionStatus: "active" });
    expect(Object.keys(row).sort()).toEqual(["createdAt", "id", "kind", "name", "periodEnd", "plan", "status", "subscriptionStatus", "trucks", "users"]);

    const act = await platformActivity(platformAdmin);
    expect(act.some((a) => a.action === "subscription.payment" && a.company === row.name)).toBe(true);
    expect(Object.keys(act[0]).sort()).toEqual(["action", "at", "by", "company", "id"]);
    const audited = await admin.db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.action, "company.create")));
    expect(audited).toHaveLength(1);
  });
});
