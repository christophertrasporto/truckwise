import { and, desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../../audit";
import { withTenant } from "../../db";
import { companyIncome, customers, users } from "../../db/schema";
import { HttpError, isUniqueViolation } from "../../errors";
import { authorize } from "../../policy";
import { assertFeature } from "../entitlements";
import type { Ctx, TenantActor } from "../trips";
import { monthRange } from "./costs";

/** Money a client paid you, recorded by hand. This is a cash record, kept apart from trip invoices. */
export const incomeInput = z.object({
  customerId: z.string().uuid(),
  amountCentavos: z.number().int().min(1).max(100_000_000_00),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-19"),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type IncomeInput = z.infer<typeof incomeInput>;

export async function addIncome(actor: TenantActor, input: IncomeInput, ctx: Ctx = {}) {
  authorize(actor, "income:write");
  try {
    return await withTenant(actor.tenantId, actor.userId, async (db) => {
      await assertFeature(db, actor.tenantId, "costs");
      const [dupe] = await db.select().from(companyIncome).where(eq(companyIncome.idempotencyKey, input.idempotencyKey));
      if (dupe) return { id: dupe.id, duplicate: true as const };
      // Reading the client through row-level security proves it is one of ours.
      const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId));
      if (!c) throw new HttpError(400, "Unknown client");
      const [row] = await db.insert(companyIncome).values({ ...input, tenantId: actor.tenantId, createdBy: actor.userId }).returning({ id: companyIncome.id });
      await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "income.add", entityType: "company_income", entityId: row.id, newValue: { customerId: input.customerId, amountCentavos: input.amountCentavos, receivedOn: input.receivedOn }, requestId: ctx.requestId });
      return { id: row.id, duplicate: false as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "That payment was already recorded");
    throw err;
  }
}

export async function voidIncome(actor: TenantActor, id: string, reason: string, ctx: Ctx = {}) {
  authorize(actor, "income:write");
  if (reason.trim().length < 3) throw new HttpError(400, "Give a reason");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [i] = await db.select().from(companyIncome).where(eq(companyIncome.id, id)).for("update");
    if (!i) throw new HttpError(404, "Income entry not found");
    if (i.voidedAt) throw new HttpError(409, "Already voided");
    await db.update(companyIncome).set({ voidedAt: new Date(), voidedBy: actor.userId, voidReason: reason.trim() }).where(eq(companyIncome.id, id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "income.void", entityType: "company_income", entityId: id, oldValue: { amountCentavos: i.amountCentavos }, newValue: { reason: reason.trim() }, requestId: ctx.requestId });
  });
}

/** One month of money received, newest first, with totals per client. Voided entries are listed but not counted. */
export async function incomeLedger(actor: TenantActor, opts: { month: string; customerId?: string }) {
  authorize(actor, "income:read");
  const { firstDay, nextFirstDay } = monthRange(opts.month);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    await assertFeature(db, actor.tenantId, "costs");
    const rows = await db
      .select({ i: companyIncome, client: customers.name, by: users.name })
      .from(companyIncome)
      .innerJoin(customers, eq(customers.id, companyIncome.customerId))
      .innerJoin(users, eq(users.id, companyIncome.createdBy))
      .where(and(gte(companyIncome.receivedOn, firstDay), lt(companyIncome.receivedOn, nextFirstDay), opts.customerId ? eq(companyIncome.customerId, opts.customerId) : undefined))
      .orderBy(desc(companyIncome.receivedOn), desc(companyIncome.createdAt));
    const counted = rows.filter((r) => !r.i.voidedAt);
    const byClient = new Map<string, { clientId: string; client: string; amountCentavos: number }>();
    for (const r of counted) {
      const cur = byClient.get(r.i.customerId) ?? { clientId: r.i.customerId, client: r.client, amountCentavos: 0 };
      cur.amountCentavos += r.i.amountCentavos;
      byClient.set(r.i.customerId, cur);
    }
    return {
      month: opts.month,
      totalCentavos: counted.reduce((n, r) => n + r.i.amountCentavos, 0),
      byClient: [...byClient.values()].sort((a, b) => b.amountCentavos - a.amountCentavos),
      rows: rows.map((r) => ({ id: r.i.id, clientId: r.i.customerId, client: r.client, amountCentavos: r.i.amountCentavos, receivedOn: r.i.receivedOn, note: r.i.note, recordedBy: r.by, voided: !!r.i.voidedAt, voidReason: r.i.voidReason })),
    };
  });
}
