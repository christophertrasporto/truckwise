import { assertFeature } from "../entitlements";
import { and, asc, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { COST_KEYS, SENSITIVE_COSTS, costLabel } from "@/shared/costs";
import { writeAudit } from "../../audit";
import { withTenant } from "../../db";
import { companyExpenses, customers, tripStatusEvents, trips, trucks, users } from "../../db/schema";
import { HttpError, isUniqueViolation } from "../../errors";
import { authorize } from "../../policy";
import type { Ctx, TenantActor } from "../trips";
import { financialsFor } from "./profit";

export const costInput = z.object({
  category: z.enum(COST_KEYS),
  amountCentavos: z.number().int().min(1).max(100_000_000_00),
  incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-19"),
  note: z.string().trim().max(500).optional(),
  payee: z.string().trim().max(200).optional(),
  truckId: z.string().uuid().optional(),
  tripId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type CostInput = z.infer<typeof costInput>;

/** Salaries are for the owner and accountant only; everyone else with cost access sees the rest of the ledger. */
const canSeeSalary = (a: TenantActor) => a.role === "owner" || a.role === "accountant";
const hidden = (a: TenantActor) => (canSeeSalary(a) ? [] : [...SENSITIVE_COSTS]);

/** Month boundaries in Asia/Manila (UTC+8, no DST). */
export function monthRange(month: string): { from: Date; to: Date; firstDay: string; nextFirstDay: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "Use a month like 2026-11");
  const [y, m] = month.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const firstDay = `${month}-01`;
  const nextFirstDay = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  return { from: new Date(`${firstDay}T00:00:00+08:00`), to: new Date(`${nextFirstDay}T00:00:00+08:00`), firstDay, nextFirstDay };
}

export async function addCost(actor: TenantActor, input: CostInput, ctx: Ctx = {}) {
  authorize(actor, "cost:write");
  await withTenant(actor.tenantId, actor.userId, (db) => assertFeature(db, actor.tenantId, "costs"));
  if ((SENSITIVE_COSTS as readonly string[]).includes(input.category) && !canSeeSalary(actor)) {
    throw new HttpError(403, "Only the owner and accountant can record salaries");
  }
  try {
    return await withTenant(actor.tenantId, actor.userId, async (db) => {
      const [dupe] = await db.select().from(companyExpenses).where(eq(companyExpenses.idempotencyKey, input.idempotencyKey));
      if (dupe) return { id: dupe.id, duplicate: true as const };
      // A foreign key alone would accept another company's id; reading it through row-level security proves it is ours.
      if (input.truckId && !(await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.id, input.truckId))).length) throw new HttpError(400, "Unknown truck");
      if (input.tripId && !(await db.select({ id: trips.id }).from(trips).where(eq(trips.id, input.tripId))).length) throw new HttpError(400, "Unknown trip");
      const [row] = await db
        .insert(companyExpenses)
        .values({ ...input, tenantId: actor.tenantId, createdBy: actor.userId })
        .returning({ id: companyExpenses.id });
      await writeAudit(db, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "cost.add",
        entityType: "company_expense",
        entityId: row.id,
        newValue: { category: input.category, amountCentavos: input.amountCentavos, incurredOn: input.incurredOn, truckId: input.truckId ?? null, tripId: input.tripId ?? null },
        requestId: ctx.requestId,
      });
      return { id: row.id, duplicate: false as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "That cost was already recorded");
    throw err;
  }
}

export async function voidCost(actor: TenantActor, id: string, reason: string, ctx: Ctx = {}) {
  authorize(actor, "cost:write");
  if (reason.trim().length < 3) throw new HttpError(400, "Give a reason");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [c] = await db.select().from(companyExpenses).where(eq(companyExpenses.id, id)).for("update");
    if (!c) throw new HttpError(404, "Cost not found");
    if ((SENSITIVE_COSTS as readonly string[]).includes(c.category) && !canSeeSalary(actor)) throw new HttpError(404, "Cost not found");
    if (c.voidedAt) throw new HttpError(409, "Already voided");
    await db.update(companyExpenses).set({ voidedAt: new Date(), voidedBy: actor.userId, voidReason: reason.trim() }).where(eq(companyExpenses.id, id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "cost.void", entityType: "company_expense", entityId: id, oldValue: { category: c.category, amountCentavos: c.amountCentavos }, newValue: { reason: reason.trim() }, requestId: ctx.requestId });
  });
}

/** The ledger for one month, newest first, with totals by category and by truck. Voided rows are listed but not counted. */
export async function costLedger(actor: TenantActor, opts: { month: string; category?: string }) {
  authorize(actor, "cost:read");
  const { firstDay, nextFirstDay } = monthRange(opts.month);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ c: companyExpenses, plate: trucks.plate, ref: trips.reference, by: users.name })
      .from(companyExpenses)
      .leftJoin(trucks, eq(trucks.id, companyExpenses.truckId))
      .leftJoin(trips, eq(trips.id, companyExpenses.tripId))
      .innerJoin(users, eq(users.id, companyExpenses.createdBy))
      .where(and(gte(companyExpenses.incurredOn, firstDay), lt(companyExpenses.incurredOn, nextFirstDay)))
      .orderBy(desc(companyExpenses.incurredOn), desc(companyExpenses.createdAt));
    const blocked = new Set<string>(hidden(actor));
    const visible = rows.filter((r) => !blocked.has(r.c.category) && (!opts.category || r.c.category === opts.category));
    const counted = visible.filter((r) => !r.c.voidedAt);
    const byCategory = new Map<string, number>();
    const byTruck = new Map<string, number>();
    for (const r of counted) {
      byCategory.set(r.c.category, (byCategory.get(r.c.category) ?? 0) + r.c.amountCentavos);
      if (r.plate) byTruck.set(r.plate, (byTruck.get(r.plate) ?? 0) + r.c.amountCentavos);
    }
    return {
      month: opts.month,
      totalCentavos: counted.reduce((n, r) => n + r.c.amountCentavos, 0),
      byCategory: [...byCategory].map(([category, amountCentavos]) => ({ category, label: costLabel(category), amountCentavos })).sort((a, b) => b.amountCentavos - a.amountCentavos),
      byTruck: [...byTruck].map(([plate, amountCentavos]) => ({ plate, amountCentavos })).sort((a, b) => b.amountCentavos - a.amountCentavos),
      salaryHidden: !canSeeSalary(actor),
      rows: visible.map((r) => ({
        id: r.c.id,
        category: r.c.category,
        label: costLabel(r.c.category),
        amountCentavos: r.c.amountCentavos,
        incurredOn: r.c.incurredOn,
        note: r.c.note,
        payee: r.c.payee,
        truckPlate: r.plate,
        tripReference: r.ref,
        tripId: r.c.tripId,
        recordedBy: r.by,
        voided: !!r.c.voidedAt,
        voidReason: r.c.voidReason,
      })),
    };
  });
}

export interface Pnl {
  month: string;
  /** Trips finished (proof approved) during the month. */
  tripCount: number;
  revenueCentavos: number;
  subcontractor: { trips: number; revenueCentavos: number; payoutCentavos: number; profitCentavos: number };
  ownTrucks: { trips: number; revenueCentavos: number; driverPayCentavos: number; helperPayCentavos: number; profitCentavos: number };
  /** Trip profit summed (customer charge - payouts - driver pay - costs tied to the trip). */
  tripProfitCentavos: number;
  /** Costs not tied to a trip: salaries, maintenance, insurance and so on. */
  overheadCentavos: number;
  overheadByCategory: { category: string; label: string; amountCentavos: number }[];
  /** Trip profit minus overhead. */
  netProfitCentavos: number;
  netMarginBps: number | null;
}

/**
 * Company profit for a month. Counts each peso once: costs linked to a trip are already inside that trip's profit,
 * so only the costs with no trip are subtracted as overhead. Owner and accountant only, because it includes salaries.
 */
export async function companyPnl(actor: TenantActor, month: string): Promise<Pnl> {
  authorize(actor, "pnl:read");
  const { from, to, firstDay, nextFirstDay } = monthRange(month);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    await assertFeature(db, actor.tenantId, "pnl");
    const done = await db
      .select({ tripId: tripStatusEvents.tripId })
      .from(tripStatusEvents)
      .where(and(eq(tripStatusEvents.toStatus, "ready_for_invoice"), gte(tripStatusEvents.createdAt, from), lt(tripStatusEvents.createdAt, to)));
    const ids = [...new Set(done.map((d) => d.tripId))];
    const rows = ids.length
      ? await db.select({ trip: trips, customerName: customers.name }).from(trips).innerJoin(customers, eq(customers.id, trips.customerId)).where(and(inArray(trips.id, ids), eq(trips.status, "ready_for_invoice"))).orderBy(asc(trips.createdAt))
      : [];
    const items = await financialsFor(db, actor.tenantId, rows);
    const sub = items.filter((i) => i.assignedTo === "partner");
    const own = items.filter((i) => i.assignedTo !== "partner");
    const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);

    const overhead = await db
      .select()
      .from(companyExpenses)
      .where(and(isNull(companyExpenses.voidedAt), isNull(companyExpenses.tripId), gte(companyExpenses.incurredOn, firstDay), lt(companyExpenses.incurredOn, nextFirstDay)));
    const byCat = new Map<string, number>();
    for (const o of overhead) byCat.set(o.category, (byCat.get(o.category) ?? 0) + o.amountCentavos);

    const revenue = sum(items, (i) => i.profit.revenueCentavos);
    const tripProfit = sum(items, (i) => i.profit.profitCentavos);
    const overheadTotal = sum(overhead, (o) => o.amountCentavos);
    const net = tripProfit - overheadTotal;
    return {
      month,
      tripCount: items.length,
      revenueCentavos: revenue,
      subcontractor: {
        trips: sub.length,
        revenueCentavos: sum(sub, (i) => i.profit.revenueCentavos),
        payoutCentavos: sum(sub, (i) => i.profit.partnerPayoutCentavos),
        profitCentavos: sum(sub, (i) => i.profit.profitCentavos),
      },
      ownTrucks: {
        trips: own.length,
        revenueCentavos: sum(own, (i) => i.profit.revenueCentavos),
        driverPayCentavos: sum(own, (i) => i.profit.driverPayCentavos),
        helperPayCentavos: sum(own, (i) => i.profit.helperPayCentavos),
        profitCentavos: sum(own, (i) => i.profit.profitCentavos),
      },
      tripProfitCentavos: tripProfit,
      overheadCentavos: overheadTotal,
      overheadByCategory: [...byCat].map(([category, amountCentavos]) => ({ category, label: costLabel(category), amountCentavos })).sort((a, b) => b.amountCentavos - a.amountCentavos),
      netProfitCentavos: net,
      netMarginBps: revenue > 0 ? Math.round((net * 10_000) / revenue) : null,
    };
  });
}
