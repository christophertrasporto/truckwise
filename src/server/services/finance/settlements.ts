import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../../audit";
import { withContext, withTenant, type Db } from "../../db";
import { settlementLines, settlements, tenants, tripAssignments, tripStops, trips } from "../../db/schema";
import { HttpError, isUniqueViolation } from "../../errors";
import { emitEvent } from "../../notify/events";
import { authorize } from "../../policy";
import type { Ctx, TenantActor } from "../trips";
import { nextDocumentNumber } from "./shared";

export const generateSettlementInput = z.object({
  partnerTenantId: z.string().uuid(),
  tripIds: z.array(z.string().uuid()).min(1).max(200),
  idempotencyKey: z.string().min(8).max(100),
});
export type GenerateSettlementInput = z.infer<typeof generateSettlementInput>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function routeLabels(db: Db, tripIds: string[]) {
  const stops = await db.select().from(tripStops).where(inArray(tripStops.tripId, tripIds)).orderBy(asc(tripStops.seq));
  const out = new Map<string, string>();
  for (const id of tripIds) {
    const mine = stops.filter((s) => s.tripId === id);
    out.set(id, `${mine.find((s) => s.kind === "pickup")?.address ?? "?"} to ${[...mine].reverse().find((s) => s.kind === "delivery")?.address ?? "?"}`);
  }
  return out;
}

/** Finished trips done by a subcontractor that no active settlement covers, grouped by partner company. */
export async function settleableTrips(actor: TenantActor) {
  authorize(actor, "finance:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ trip: trips, a: tripAssignments, partnerName: tenants.name })
      .from(trips)
      .innerJoin(tripAssignments, and(eq(tripAssignments.tripId, trips.id), eq(tripAssignments.status, "active")))
      .innerJoin(tenants, eq(tenants.id, tripAssignments.assignedTenantId))
      .where(eq(trips.status, "ready_for_invoice"))
      .orderBy(asc(trips.createdAt));
    const done = new Set((await db.select({ tripId: settlementLines.tripId }).from(settlementLines).where(eq(settlementLines.active, true))).map((l) => l.tripId));
    const external = rows.filter((r) => r.a.assignedTenantId !== actor.tenantId && !done.has(r.trip.id));
    const routes = await routeLabels(db, external.map((r) => r.trip.id));
    const groups = new Map<string, { partnerTenantId: string; partnerName: string; trips: { id: string; reference: string; route: string; amountCentavos: number }[]; totalCentavos: number }>();
    for (const r of external) {
      const g = groups.get(r.a.assignedTenantId) ?? { partnerTenantId: r.a.assignedTenantId, partnerName: r.partnerName, trips: [], totalCentavos: 0 };
      g.trips.push({ id: r.trip.id, reference: r.trip.reference, route: routes.get(r.trip.id) ?? "", amountCentavos: (r.trip.subcontractorPayoutCentavos ?? r.trip.payoutCentavos) });
      g.totalCentavos += (r.trip.subcontractorPayoutCentavos ?? r.trip.payoutCentavos);
      groups.set(r.a.assignedTenantId, g);
    }
    return [...groups.values()];
  });
}

/**
 * Create a settlement for one subcontractor from the payout agreed on each finished trip. Idempotent in the
 * same way as invoices: the same key returns the same settlement, and a trip on an active settlement is refused.
 */
export async function generateSettlement(actor: TenantActor, input: GenerateSettlementInput, ctx: Ctx = {}) {
  authorize(actor, "settlement:manage");
  const tripIds = [...new Set(input.tripIds)].sort();
  try {
    return await withTenant(actor.tenantId, actor.userId, async (db) => {
      const [existing] = await db.select().from(settlements).where(eq(settlements.idempotencyKey, input.idempotencyKey));
      if (existing) return { id: existing.id, number: existing.number, duplicate: true as const };

      const rows = await db.select().from(trips).where(inArray(trips.id, tripIds)).orderBy(asc(trips.id)).for("update");
      if (rows.length !== tripIds.length) throw new HttpError(404, "One of the trips was not found");
      const notReady = rows.filter((t) => t.status !== "ready_for_invoice");
      if (notReady.length) throw new HttpError(409, `Not finished yet: ${notReady.map((t) => t.reference).join(", ")}`);
      const assigns = await db.select().from(tripAssignments).where(and(inArray(tripAssignments.tripId, tripIds), eq(tripAssignments.status, "active")));
      const wrong = rows.filter((t) => assigns.find((a) => a.tripId === t.id)?.assignedTenantId !== input.partnerTenantId);
      if (wrong.length) throw new HttpError(400, `Not done by that subcontractor: ${wrong.map((t) => t.reference).join(", ")}`);
      const already = await db.select({ tripId: settlementLines.tripId }).from(settlementLines).where(and(inArray(settlementLines.tripId, tripIds), eq(settlementLines.active, true)));
      if (already.length) {
        const refs = rows.filter((t) => already.some((a) => a.tripId === t.id)).map((t) => t.reference);
        throw Object.assign(new HttpError(409, `Already settled: ${refs.join(", ")}`), { code: "already_settled" });
      }

      const total = rows.reduce((n, t) => n + (t.subcontractorPayoutCentavos ?? t.payoutCentavos), 0);
      const number = await nextDocumentNumber(db, actor.tenantId, "settlement");
      const [s] = await db
        .insert(settlements)
        .values({ tenantId: actor.tenantId, number, partnerTenantId: input.partnerTenantId, idempotencyKey: input.idempotencyKey, totalCentavos: total, createdBy: actor.userId })
        .returning();
      const routes = await routeLabels(db, tripIds);
      await db.insert(settlementLines).values(
        rows.map((t) => ({ tenantId: actor.tenantId, settlementId: s.id, tripId: t.id, description: `${t.reference}: ${routes.get(t.id)}`, amountCentavos: t.subcontractorPayoutCentavos ?? t.payoutCentavos })),
      );
      await writeAudit(db, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "settlement.issue",
        entityType: "settlement",
        entityId: s.id,
        newValue: { number, partnerTenantId: input.partnerTenantId, trips: rows.map((t) => t.reference), totalCentavos: total },
        requestId: ctx.requestId,
      });
      await emitEvent(db, { type: "settlement.changed", tenantId: actor.tenantId, settlementId: s.id, what: "issued" });
      return { id: s.id, number, duplicate: false as const };
    });
  } catch (err) {
    if (isUniqueViolation(err) || (err as { code?: string })?.code === "already_settled") {
      const winner = await withTenant(actor.tenantId, actor.userId, (db) => db.select().from(settlements).where(eq(settlements.idempotencyKey, input.idempotencyKey)));
      if (winner[0]) return { id: winner[0].id, number: winner[0].number, duplicate: true as const };
      if (isUniqueViolation(err)) throw Object.assign(new HttpError(409, "One of these trips was just settled"), { code: "already_settled" });
    }
    throw err;
  }
}

/** Settle every finished, unsettled trip of one subcontractor. Running it again finds nothing. */
export async function settleAllReady(actor: TenantActor, partnerTenantId: string, idempotencyKey: string, ctx: Ctx = {}) {
  authorize(actor, "settlement:manage");
  const [group] = (await settleableTrips(actor)).filter((g) => g.partnerTenantId === partnerTenantId);
  if (!group) {
    const replay = await withTenant(actor.tenantId, actor.userId, (db) => db.select().from(settlements).where(eq(settlements.idempotencyKey, idempotencyKey)));
    if (replay[0]) return { created: false as const, id: replay[0].id, number: replay[0].number };
    return { created: false as const, id: null, number: null };
  }
  const r = await generateSettlement(actor, { partnerTenantId, tripIds: group.trips.map((t) => t.id), idempotencyKey }, ctx);
  return { created: !r.duplicate, id: r.id, number: r.number };
}

export async function listSettlements(actor: TenantActor) {
  authorize(actor, "finance:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ s: settlements, partnerName: tenants.name })
      .from(settlements)
      .innerJoin(tenants, eq(tenants.id, settlements.partnerTenantId))
      .orderBy(desc(settlements.issuedAt));
    return rows.map(({ s, partnerName }) => ({ id: s.id, number: s.number, partnerName, status: s.status, totalCentavos: s.totalCentavos, issuedAt: iso(s.issuedAt), paidAt: iso(s.paidAt) }));
  });
}

async function linesOf(db: Db, settlementId: string) {
  const rows = await db
    .select({ l: settlementLines, reference: trips.reference })
    .from(settlementLines)
    .innerJoin(trips, eq(trips.id, settlementLines.tripId))
    .where(eq(settlementLines.settlementId, settlementId));
  return rows.map(({ l, reference }) => ({ id: l.id, tripId: l.tripId, reference, description: l.description, amountCentavos: l.amountCentavos }));
}

export async function getSettlement(actor: TenantActor, id: string) {
  authorize(actor, "finance:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [row] = await db
      .select({ s: settlements, partnerName: tenants.name })
      .from(settlements)
      .innerJoin(tenants, eq(tenants.id, settlements.partnerTenantId))
      .where(eq(settlements.id, id));
    if (!row) throw new HttpError(404, "Settlement not found");
    const s = row.s;
    return {
      id: s.id,
      number: s.number,
      partnerName: row.partnerName,
      status: s.status,
      totalCentavos: s.totalCentavos,
      issuedAt: iso(s.issuedAt),
      paidAt: iso(s.paidAt),
      paymentReference: s.paymentReference,
      voidedAt: iso(s.voidedAt),
      voidReason: s.voidReason,
      lines: await linesOf(db, id),
    };
  });
}

export async function markSettlementPaid(actor: TenantActor, id: string, input: { reference: string; paidAt?: string }, ctx: Ctx = {}) {
  authorize(actor, "settlement:manage");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [s] = await db.select().from(settlements).where(eq(settlements.id, id)).for("update");
    if (!s) throw new HttpError(404, "Settlement not found");
    if (s.status !== "issued") throw new HttpError(409, `This settlement is already ${s.status}`);
    await db.update(settlements).set({ status: "paid", paidAt: input.paidAt ? new Date(input.paidAt) : new Date(), paymentReference: input.reference }).where(eq(settlements.id, id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "settlement.paid", entityType: "settlement", entityId: id, newValue: { reference: input.reference }, requestId: ctx.requestId });
    await emitEvent(db, { type: "settlement.changed", tenantId: actor.tenantId, settlementId: id, what: "paid" });
  });
}

export async function voidSettlement(actor: TenantActor, id: string, reason: string, ctx: Ctx = {}) {
  authorize(actor, "settlement:manage");
  if (reason.trim().length < 3) throw new HttpError(400, "Give a reason");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [s] = await db.select().from(settlements).where(eq(settlements.id, id)).for("update");
    if (!s) throw new HttpError(404, "Settlement not found");
    if (s.status !== "issued") throw new HttpError(409, `A ${s.status} settlement cannot be voided`);
    await db.update(settlements).set({ status: "void", voidedAt: new Date(), voidedBy: actor.userId, voidReason: reason.trim() }).where(eq(settlements.id, id));
    await db.update(settlementLines).set({ active: false }).where(eq(settlementLines.settlementId, id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "settlement.void", entityType: "settlement", entityId: id, oldValue: { number: s.number, totalCentavos: s.totalCentavos }, newValue: { reason: reason.trim() }, requestId: ctx.requestId });
  });
}

// ---------------------------------------------------------------------------
// The subcontractor's own view: only settlements addressed to their company
// ---------------------------------------------------------------------------

async function myHaulers(actor: TenantActor): Promise<{ id: string; name: string }[]> {
  const ids = await withContext({ tenantId: actor.tenantId, userId: actor.userId }, async (db) => {
    const res = await db.execute<{ id: string }>(sql`select my_settlement_hauler_ids() as id`);
    return (res as unknown as { id: string }[]).map((r) => r.id);
  });
  const out: { id: string; name: string }[] = [];
  for (const id of ids) {
    const [t] = await withTenant(actor.tenantId, actor.userId, (db) => db.select({ id: tenants.id, name: tenants.name }).from(tenants).where(eq(tenants.id, id)));
    if (t) out.push(t);
  }
  return out;
}

/** Settlements a trucking company has issued to the caller's subcontractor company. No customer rate is ever in these. */
export async function listMySettlements(actor: TenantActor) {
  authorize(actor, "settlement:read_own");
  const out = [];
  for (const h of await myHaulers(actor)) {
    const rows = await withTenant(h.id, actor.userId, (db) =>
      db.select().from(settlements).where(eq(settlements.partnerTenantId, actor.tenantId)).orderBy(desc(settlements.issuedAt)),
    );
    for (const s of rows) out.push({ id: s.id, haulerTenantId: h.id, haulerName: h.name, number: s.number, status: s.status, totalCentavos: s.totalCentavos, issuedAt: iso(s.issuedAt), paidAt: iso(s.paidAt) });
  }
  return out;
}

export async function getMySettlement(actor: TenantActor, haulerId: string, id: string) {
  authorize(actor, "settlement:read_own");
  if (!(await myHaulers(actor)).some((h) => h.id === haulerId)) throw new HttpError(404, "Settlement not found");
  return withTenant(haulerId, actor.userId, async (db) => {
    const [s] = await db.select().from(settlements).where(and(eq(settlements.id, id), eq(settlements.partnerTenantId, actor.tenantId)));
    if (!s) throw new HttpError(404, "Settlement not found");
    return {
      id: s.id,
      number: s.number,
      status: s.status,
      totalCentavos: s.totalCentavos,
      issuedAt: iso(s.issuedAt),
      paidAt: iso(s.paidAt),
      paymentReference: s.paymentReference,
      lines: (await linesOf(db, id)).map((l) => ({ reference: l.reference, description: l.description, amountCentavos: l.amountCentavos })),
    };
  });
}

