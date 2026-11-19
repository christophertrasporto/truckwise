import { randomBytes } from "node:crypto";
import { and, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { changePlanInput, createCompanyInput, planInput, recordPaymentInput, setCompanyStatusInput, type PlanInput } from "@/shared/plans";
import type { z } from "zod";
import { writeAudit } from "../audit";
import { hashPassword } from "../auth/sessions";
import { withContext, type Db } from "../db";
import { auditLog, companySettings, memberships, subscriptionPayments, subscriptionPlans, subscriptions, tenants, trucks, users } from "../db/schema";
import { HttpError, isUniqueViolation } from "../errors";
import { emitEvent } from "../notify/events";
import { authorize, type Actor } from "../policy";

/**
 * Platform administration: companies, plans, subscriptions and their manual payments.
 *
 * What the platform administrator can see about a company is deliberately thin: its name, status, plan and head
 * counts. Never its clients, trips, rates, documents or notifications. Nothing in this file reads those tables.
 */
type Ctx = { requestId?: string };

const platform = <T>(actor: Actor, fn: (db: Db) => Promise<T>) => withContext({ platform: true, userId: actor.userId }, fn);

/** Adds whole months in UTC (a monthly plan bought on the 31st ends on the last day of the next month, never skipping one). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function listPlans(actor: Actor) {
  authorize(actor, "tenant:read_all");
  return platform(actor, async (db) => {
    const plans = await db.select().from(subscriptionPlans).orderBy(subscriptionPlans.priceCentavos);
    const used = await db.select({ planId: subscriptions.planId, n: count() }).from(subscriptions).groupBy(subscriptions.planId);
    const byPlan = new Map(used.map((u) => [u.planId, Number(u.n)]));
    return plans.map((p) => ({ ...p, companies: byPlan.get(p.id) ?? 0 }));
  });
}

export async function createPlan(actor: Actor, input: PlanInput, ctx: Ctx = {}) {
  authorize(actor, "tenant:create");
  const v = planInput.parse(input);
  try {
    return await platform(actor, async (db) => {
      const [p] = await db.insert(subscriptionPlans).values({ ...v }).returning({ id: subscriptionPlans.id });
      await writeAudit(db, { tenantId: null, actorUserId: actor.userId, action: "plan.create", entityType: "subscription_plan", entityId: p.id, newValue: v, requestId: ctx.requestId });
      return { id: p.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "A plan with that name already exists");
    throw err;
  }
}

export async function updatePlan(actor: Actor, id: string, input: PlanInput, ctx: Ctx = {}) {
  authorize(actor, "tenant:create");
  const v = planInput.parse(input);
  return platform(actor, async (db) => {
    const [old] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id)).for("update");
    if (!old) throw new HttpError(404, "Plan not found");
    await db.update(subscriptionPlans).set({ ...v }).where(eq(subscriptionPlans.id, id));
    await writeAudit(db, {
      tenantId: null,
      actorUserId: actor.userId,
      action: "plan.update",
      entityType: "subscription_plan",
      entityId: id,
      oldValue: { name: old.name, priceCentavos: old.priceCentavos, maxTrucks: old.maxTrucks, maxDrivers: old.maxDrivers, maxUsers: old.maxUsers, features: old.features, active: old.active },
      newValue: v,
      requestId: ctx.requestId,
    });
  });
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export async function listCompanies(actor: Actor) {
  authorize(actor, "tenant:read_all");
  return platform(actor, async (db) => {
    const rows = await db
      .select({ t: tenants, s: subscriptions, planName: subscriptionPlans.name })
      .from(tenants)
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
      .orderBy(desc(tenants.createdAt));
    const people = await db.select({ tenantId: memberships.tenantId, n: count() }).from(memberships).where(eq(memberships.status, "active")).groupBy(memberships.tenantId);
    const fleet = await db.select({ tenantId: trucks.tenantId, n: count() }).from(trucks).groupBy(trucks.tenantId);
    const pn = new Map(people.map((x) => [x.tenantId, Number(x.n)]));
    const fn = new Map(fleet.map((x) => [x.tenantId, Number(x.n)]));
    return rows.map(({ t, s, planName }) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      plan: planName,
      subscriptionStatus: s?.status ?? null,
      periodEnd: s?.periodEnd.toISOString() ?? null,
      users: pn.get(t.id) ?? 0,
      trucks: fn.get(t.id) ?? 0,
    }));
  });
}

export async function getCompany(actor: Actor, id: string) {
  authorize(actor, "tenant:read_all");
  return platform(actor, async (db) => {
    const [row] = await db
      .select({ t: tenants, s: subscriptions, p: subscriptionPlans })
      .from(tenants)
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
      .where(eq(tenants.id, id));
    if (!row) throw new HttpError(404, "Company not found");
    const owners = await db
      .select({ name: users.name, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, id), inArray(memberships.role, ["owner", "sub_owner"])));
    const [{ n: people }] = await db.select({ n: count() }).from(memberships).where(and(eq(memberships.tenantId, id), eq(memberships.status, "active")));
    const [{ n: fleet }] = await db.select({ n: count() }).from(trucks).where(eq(trucks.tenantId, id));
    const payments = row.s
      ? await db.select().from(subscriptionPayments).where(eq(subscriptionPayments.tenantId, id)).orderBy(desc(subscriptionPayments.paidOn), desc(subscriptionPayments.createdAt))
      : [];
    return {
      id: row.t.id,
      name: row.t.name,
      kind: row.t.kind,
      status: row.t.status,
      createdAt: row.t.createdAt.toISOString(),
      owners,
      users: Number(people),
      trucks: Number(fleet),
      subscription: row.s && row.p ? { id: row.s.id, planId: row.p.id, plan: row.p.name, status: row.s.status, periodStart: row.s.periodStart.toISOString(), periodEnd: row.s.periodEnd.toISOString(), priceCentavos: row.p.priceCentavos, periodMonths: row.p.periodMonths } : null,
      payments: payments.map((p) => ({ id: p.id, amountCentavos: p.amountCentavos, paidOn: p.paidOn, method: p.method, reference: p.reference, periodsAdded: p.periodsAdded })),
    };
  });
}

/**
 * Creates a trucking company with its owner login and a subscription (on a free trial by default). The owner gets a
 * one-time starting password, returned once; an existing person keeps the password they already have.
 */
export async function createCompany(actor: Actor, input: z.input<typeof createCompanyInput>, ctx: Ctx = {}) {
  authorize(actor, "tenant:create");
  const v = createCompanyInput.parse(input);
  const password = randomBytes(9).toString("base64url");
  return platform(actor, async (db) => {
    const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, v.planId));
    if (!plan || !plan.active) throw new HttpError(400, "Choose an active plan");
    const [t] = await db.insert(tenants).values({ name: v.companyName, kind: "hauler" }).returning();
    let [owner] = await db.select().from(users).where(eq(users.email, v.ownerEmail));
    const existingAccount = !!owner;
    if (!owner) [owner] = await db.insert(users).values({ email: v.ownerEmail, name: v.ownerName, passwordHash: await hashPassword(password) }).returning();
    await db.insert(memberships).values({ tenantId: t.id, userId: owner.id, role: "owner" });
    await db.insert(companySettings).values({ tenantId: t.id });
    const now = new Date();
    const trial = v.trialDays > 0;
    await db.insert(subscriptions).values({
      tenantId: t.id,
      planId: plan.id,
      status: trial ? "trialing" : "active",
      periodStart: now,
      periodEnd: trial ? new Date(now.getTime() + v.trialDays * 86_400_000) : addMonths(now, plan.periodMonths),
    });
    await writeAudit(db, { tenantId: t.id, actorUserId: actor.userId, action: "company.create", entityType: "tenant", entityId: t.id, newValue: { name: v.companyName, plan: plan.name, trialDays: v.trialDays, ownerEmail: v.ownerEmail }, requestId: ctx.requestId });
    return { tenantId: t.id, ownerEmail: v.ownerEmail, temporaryPassword: existingAccount ? null : password };
  });
}

/** Suspend or reactivate a company. A suspended company's people can sign in only to see the renewal notice. */
export async function setCompanyStatus(actor: Actor, id: string, input: z.infer<typeof setCompanyStatusInput>, ctx: Ctx = {}) {
  authorize(actor, "tenant:suspend");
  const v = setCompanyStatusInput.parse(input);
  return platform(actor, async (db) => {
    const [t] = await db.select().from(tenants).where(eq(tenants.id, id)).for("update");
    if (!t) throw new HttpError(404, "Company not found");
    if (t.status === v.status) return { status: t.status };
    await db.update(tenants).set({ status: v.status }).where(eq(tenants.id, id));
    await writeAudit(db, { tenantId: id, actorUserId: actor.userId, action: v.status === "suspended" ? "company.suspend" : "company.reactivate", entityType: "tenant", entityId: id, oldValue: { status: t.status }, newValue: { status: v.status, reason: v.reason }, requestId: ctx.requestId });
    return { status: v.status };
  });
}

// ---------------------------------------------------------------------------
// Subscriptions and their payments
// ---------------------------------------------------------------------------

/** Move a company to another plan. Limits apply at once; the paid-up period is kept. */
export async function changePlan(actor: Actor, tenantId: string, input: z.infer<typeof changePlanInput>, ctx: Ctx = {}) {
  authorize(actor, "tenant:create");
  const v = changePlanInput.parse(input);
  return platform(actor, async (db) => {
    const [s] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).for("update");
    if (!s) throw new HttpError(404, "This company has no subscription");
    const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, v.planId));
    if (!plan || !plan.active) throw new HttpError(400, "Choose an active plan");
    await db.update(subscriptions).set({ planId: plan.id, updatedAt: new Date() }).where(eq(subscriptions.id, s.id));
    await writeAudit(db, { tenantId, actorUserId: actor.userId, action: "subscription.change_plan", entityType: "subscription", entityId: s.id, oldValue: { planId: s.planId }, newValue: { planId: plan.id, plan: plan.name }, requestId: ctx.requestId });
  });
}

/**
 * Record money the company paid for its subscription (manual in v1) and extend its period. Sending the same
 * idempotency key twice records it once. A subscription that had expired comes back to life and its company is
 * reactivated; a company the administrator suspended by hand stays suspended until reactivated deliberately.
 */
export async function recordPayment(actor: Actor, tenantId: string, input: z.input<typeof recordPaymentInput>, ctx: Ctx = {}) {
  authorize(actor, "tenant:create");
  const v = recordPaymentInput.parse(input);
  try {
    return await platform(actor, async (db) => {
      const [dupe] = await db.select().from(subscriptionPayments).where(eq(subscriptionPayments.idempotencyKey, v.idempotencyKey));
      if (dupe) {
        if (dupe.tenantId !== tenantId) throw new HttpError(409, "That reference was already used");
        return { id: dupe.id, duplicate: true as const, periodEnd: null };
      }
      const [s] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).for("update");
      if (!s) throw new HttpError(404, "This company has no subscription");
      const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, s.planId));
      const now = new Date();
      const base = s.periodEnd > now ? s.periodEnd : now; // paying early extends from the end; paying late starts today
      const periodEnd = addMonths(base, plan.periodMonths * v.periodsAdded);
      const [p] = await db.insert(subscriptionPayments).values({ tenantId, subscriptionId: s.id, amountCentavos: v.amountCentavos, paidOn: v.paidOn, method: v.method, reference: v.reference, periodsAdded: v.periodsAdded, recordedBy: actor.userId, idempotencyKey: v.idempotencyKey }).returning({ id: subscriptionPayments.id });
      await db.update(subscriptions).set({ status: "active", periodStart: s.periodEnd > now ? s.periodStart : now, periodEnd, updatedAt: now }).where(eq(subscriptions.id, s.id));
      if (s.status === "expired") await db.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantId));
      await writeAudit(db, { tenantId, actorUserId: actor.userId, action: "subscription.payment", entityType: "subscription_payment", entityId: p.id, newValue: { amountCentavos: v.amountCentavos, paidOn: v.paidOn, periodsAdded: v.periodsAdded, periodEnd: periodEnd.toISOString() }, requestId: ctx.requestId });
      return { id: p.id, duplicate: false as const, periodEnd: periodEnd.toISOString() };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "That payment was already recorded");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dashboard and activity
// ---------------------------------------------------------------------------

export async function platformDashboard(actor: Actor) {
  authorize(actor, "tenant:read_all");
  return platform(actor, async (db) => {
    const now = new Date();
    const soon = new Date(now.getTime() + 14 * 86_400_000);
    const byKind = await db.select({ kind: tenants.kind, status: tenants.status, n: count() }).from(tenants).groupBy(tenants.kind, tenants.status);
    const subs = await db.select({ status: subscriptions.status, n: count() }).from(subscriptions).groupBy(subscriptions.status);
    const paying = await db
      .select({ price: subscriptionPlans.priceCentavos, months: subscriptionPlans.periodMonths })
      .from(subscriptions)
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
      .where(eq(subscriptions.status, "active"));
    const expiring = await db
      .select({ id: tenants.id, name: tenants.name, end: subscriptions.periodEnd, status: subscriptions.status })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .where(and(inArray(subscriptions.status, ["trialing", "active"]), gte(subscriptions.periodEnd, now), lte(subscriptions.periodEnd, soon)))
      .orderBy(subscriptions.periodEnd);
    const n = (kind: string, status?: string) => byKind.filter((r) => r.kind === kind && (!status || r.status === status)).reduce((a, r) => a + Number(r.n), 0);
    return {
      haulers: n("hauler"),
      subcontractors: n("subcontractor"),
      suspended: byKind.filter((r) => r.status === "suspended").reduce((a, r) => a + Number(r.n), 0),
      subscriptions: Object.fromEntries(subs.map((s) => [s.status, Number(s.n)])) as Record<string, number>,
      /** Monthly recurring revenue: each active plan's price spread over its months. */
      monthlyRecurringCentavos: Math.round(paying.reduce((a, p) => a + p.price / p.months, 0)),
      expiringSoon: expiring.map((e) => ({ id: e.id, name: e.name, status: e.status, periodEnd: e.end.toISOString() })),
    };
  });
}

/** What the platform did, and what happened to companies' accounts. Only the action and where: never the values inside. */
export async function platformActivity(actor: Actor, limit = 100) {
  authorize(actor, "tenant:read_all");
  const actions = ["company.create", "company.suspend", "company.reactivate", "plan.create", "plan.update", "subscription.change_plan", "subscription.payment", "subscription.expired", "application_link.create", "partner.invite"];
  return platform(actor, async (db) => {
    const rows = await db
      .select({ id: auditLog.id, action: auditLog.action, at: auditLog.createdAt, company: tenants.name, who: users.name })
      .from(auditLog)
      .leftJoin(tenants, eq(tenants.id, auditLog.tenantId))
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(inArray(auditLog.action, actions))
      .orderBy(desc(auditLog.id))
      .limit(Math.min(limit, 500));
    return rows.map((r) => ({ id: r.id, action: r.action, at: r.at.toISOString(), company: r.company, by: r.who }));
  });
}

// ---------------------------------------------------------------------------
// Scheduled: reminders and expiry
// ---------------------------------------------------------------------------

/**
 * Run from the once-a-minute timer. Tells owners a week ahead, and when the period has passed marks the
 * subscription expired and suspends the company. Safe to run any number of times: each step is idempotent.
 */
export async function runSubscriptionSweep(now = new Date()) {
  return withContext({ platform: true }, async (db) => {
    const week = new Date(now.getTime() + 7 * 86_400_000);
    const due = await db
      .select({ id: subscriptions.id, tenantId: subscriptions.tenantId, end: subscriptions.periodEnd })
      .from(subscriptions)
      .where(and(inArray(subscriptions.status, ["trialing", "active"]), gte(subscriptions.periodEnd, now), lte(subscriptions.periodEnd, week)));
    for (const s of due) await emitEvent(db, { type: "subscription.expiring", tenantId: s.tenantId, subscriptionId: s.id, periodEnd: s.end.toISOString().slice(0, 10) });

    const lapsed = await db
      .select({ id: subscriptions.id, tenantId: subscriptions.tenantId })
      .from(subscriptions)
      .where(and(inArray(subscriptions.status, ["trialing", "active"]), lte(subscriptions.periodEnd, now)));
    for (const s of lapsed) {
      await db.update(subscriptions).set({ status: "expired", updatedAt: now }).where(eq(subscriptions.id, s.id));
      await db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, s.tenantId));
      await writeAudit(db, { tenantId: s.tenantId, actorUserId: null, action: "subscription.expired", entityType: "subscription", entityId: s.id });
    }
    return { reminded: due.length, expired: lapsed.length };
  });
}

