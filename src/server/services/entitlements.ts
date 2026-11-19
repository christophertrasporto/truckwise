import { and, eq, sql } from "drizzle-orm";
import { PLAN_FEATURES, type PlanFeature } from "@/shared/plans";
import { withContext, withUser, type Db } from "../db";
import { memberships, subscriptionPlans, subscriptions, tenants, trucks } from "../db/schema";
import { HttpError } from "../errors";

/**
 * What a company's plan allows. A company with no subscription row (the operator's own company, or one that predates
 * plans) is not limited. Enforcement lives here, on the server, next to the data; the UI only mirrors it.
 */
export interface Entitlements {
  limited: boolean;
  planName: string | null;
  maxTrucks: number | null;
  maxDrivers: number | null;
  maxUsers: number | null;
  features: Record<PlanFeature, boolean>;
}

const allFeatures = (on: boolean) => Object.fromEntries(PLAN_FEATURES.map((f) => [f.key, on])) as Record<PlanFeature, boolean>;

export async function entitlementsFor(db: Db, tenantId: string): Promise<Entitlements> {
  const [row] = await db
    .select({ plan: subscriptionPlans })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(eq(subscriptions.tenantId, tenantId));
  if (!row) return { limited: false, planName: null, maxTrucks: null, maxDrivers: null, maxUsers: null, features: allFeatures(true) };
  const p = row.plan;
  return {
    limited: true,
    planName: p.name,
    maxTrucks: p.maxTrucks,
    maxDrivers: p.maxDrivers,
    maxUsers: p.maxUsers,
    features: { ...allFeatures(false), ...p.features },
  };
}

export async function assertFeature(db: Db, tenantId: string, feature: PlanFeature): Promise<void> {
  const e = await entitlementsFor(db, tenantId);
  if (!e.features[feature]) throw new HttpError(402, `Your ${e.planName} plan does not include this. Ask the platform administrator to upgrade you.`);
}

export type Limited = "trucks" | "drivers" | "users";

/** Refuses an add that would go past the plan. Call inside the transaction that adds the row. */
export async function assertRoom(db: Db, tenantId: string, what: Limited, adding = 1): Promise<void> {
  const e = await entitlementsFor(db, tenantId);
  const max = what === "trucks" ? e.maxTrucks : what === "drivers" ? e.maxDrivers : e.maxUsers;
  if (max === null) return;
  const [{ n }] =
    what === "trucks"
      ? await db.select({ n: sql<number>`count(*)::int` }).from(trucks).where(eq(trucks.tenantId, tenantId))
      : await db
          .select({ n: sql<number>`count(*)::int` })
          .from(memberships)
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, "active"), what === "drivers" ? sql`${memberships.role} in ('driver','sub_driver')` : sql`true`));
  if (n + adding > max) throw new HttpError(402, `Your ${e.planName} plan allows up to ${max} ${what}. Ask the platform administrator to upgrade you.`);
}

/** Companies of this person that are suspended, so the sign-in can show a renewal notice instead of an empty page. */
export async function suspendedCompaniesFor(userId: string): Promise<{ name: string; since: Date | null }[]> {
  return withUser(userId, async (db) => {
    const rows = await db
      .select({ name: tenants.name, end: subscriptions.periodEnd })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .where(and(eq(memberships.userId, userId), eq(memberships.status, "active"), eq(tenants.status, "suspended")));
    return rows.map((r) => ({ name: r.name, since: r.end }));
  });
}

/** The company's own plan, for its Settings page. */
export async function mySubscription(tenantId: string, userId: string) {
  return withContext({ tenantId, userId }, async (db) => {
    const [row] = await db
      .select({ s: subscriptions, p: subscriptionPlans })
      .from(subscriptions)
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
      .where(eq(subscriptions.tenantId, tenantId));
    if (!row) return null;
    return { plan: row.p.name, status: row.s.status, periodEnd: row.s.periodEnd.toISOString(), priceCentavos: row.p.priceCentavos, periodMonths: row.p.periodMonths };
  });
}
