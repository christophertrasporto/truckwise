import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { defaultCompanyBears } from "@/shared/finance";
import { writeAudit } from "../../audit";
import { withTenant } from "../../db";
import { customers, tripAssignments, tripExpenses, trips, users } from "../../db/schema";
import { HttpError, isUniqueViolation } from "../../errors";
import { emitEvent } from "../../notify/events";
import { authorize } from "../../policy";
import { getScanner } from "../../scan";
import { MAX_FILE_BYTES, sha256, sniffImage, storage } from "../../storage";
import { lockTrip, type Ctx, type TenantActor } from "../trips";

const EXPENSE_CATEGORIES = ["fuel", "toll", "parking", "loading", "repair", "other"] as const;

export const expenseInput = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  amountCentavos: z.number().int().min(1).max(100_000_000),
  incurredAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type ExpenseInput = z.infer<typeof expenseInput>;

export const expenseReviewInput = z.object({
  decision: z.enum(["approve", "reject"]),
  /** Approve only: who carries the cost. Defaults from the trip's fuel/toll terms when omitted. */
  companyBears: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

interface Receipt {
  name: string;
  data: Buffer;
}

async function storeReceipt(tenantId: string, tripId: string, expenseId: string, r: Receipt) {
  if (r.data.length > MAX_FILE_BYTES) throw new HttpError(400, "The receipt is larger than 10 MB");
  const img = sniffImage(r.data);
  if (!img) throw new HttpError(400, "The receipt must be a JPEG, PNG or WebP photo");
  const scan = await getScanner().scan(r.data);
  if (scan.status === "infected") throw new HttpError(400, "The receipt failed the security scan and was not saved");
  if (scan.status === "error") throw new HttpError(503, "The receipt could not be checked right now. Try again shortly.");
  const key = `tenants/${tenantId}/trips/${tripId}/expenses/${expenseId}.${img.ext}`;
  await storage.put(key, r.data);
  return { key, mime: img.mime, hash: sha256(r.data), bytes: r.data.length };
}

/** A company driver reports a cost on their own trip, with a photo of the receipt. Staff decide who bears it. */
export async function submitExpense(actor: TenantActor, tripId: string, input: ExpenseInput, receipt: Receipt | null, ctx: Ctx = {}) {
  authorize(actor, "expense:submit");
  if (!receipt) throw new HttpError(400, "Attach a photo of the receipt");
  const incurredAt = new Date(input.incurredAt);
  if (incurredAt.getTime() > Date.now() + 5 * 60_000) throw new HttpError(400, "The date cannot be in the future");

  const pre = await withTenant(actor.tenantId, actor.userId, async (db) => {
    const [a] = await db
      .select({ id: tripAssignments.id })
      .from(tripAssignments)
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.driverUserId, actor.userId), eq(tripAssignments.status, "active")));
    const [dupe] = await db.select().from(tripExpenses).where(eq(tripExpenses.idempotencyKey, input.idempotencyKey));
    return { assigned: !!a, dupe };
  });
  if (!pre.assigned) throw new HttpError(404, "Trip not found");
  if (pre.dupe) {
    if (pre.dupe.tripId !== tripId || pre.dupe.submittedBy !== actor.userId) throw new HttpError(409, "Idempotency key already used");
    return { id: pre.dupe.id, duplicate: true as const };
  }

  const id = randomUUID();
  const stored = await storeReceipt(actor.tenantId, tripId, id, receipt);
  try {
    return await withTenant(actor.tenantId, actor.userId, async (db) => {
      const trip = await lockTrip(db, tripId);
      if (!trip) throw new HttpError(404, "Trip not found");
      if (trip.status === "cancelled") throw new HttpError(409, "This trip was cancelled");
      await db.insert(tripExpenses).values({
        id,
        tenantId: actor.tenantId,
        tripId,
        category: input.category,
        amountCentavos: input.amountCentavos,
        incurredAt,
        note: input.note,
        submittedBy: actor.userId,
        paidByDriverId: actor.userId,
        receiptKey: stored.key,
        receiptMime: stored.mime,
        receiptSha256: stored.hash,
        receiptBytes: stored.bytes,
        idempotencyKey: input.idempotencyKey,
      });
      await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "expense.submit", entityType: "trip_expense", entityId: id, newValue: { tripId, category: input.category, amountCentavos: input.amountCentavos }, requestId: ctx.requestId });
      await emitEvent(db, { type: "expense.submitted", tenantId: actor.tenantId, tripId, expenseId: id });
      return { id, duplicate: false as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "That expense was already recorded");
    throw err;
  }
}

/** Office staff record a company-paid cost (fuel card, toll tag, ...). It starts approved and company-borne. */
export async function addCompanyExpense(actor: TenantActor, tripId: string, input: ExpenseInput, receipt: Receipt | null, ctx: Ctx = {}) {
  authorize(actor, "expense:add");
  const id = randomUUID();
  const stored = receipt ? await storeReceipt(actor.tenantId, tripId, id, receipt) : null;
  try {
    return await withTenant(actor.tenantId, actor.userId, async (db) => {
      const [dupe] = await db.select().from(tripExpenses).where(eq(tripExpenses.idempotencyKey, input.idempotencyKey));
      if (dupe) return { id: dupe.id, duplicate: true as const };
      const trip = await lockTrip(db, tripId);
      if (!trip) throw new HttpError(404, "Trip not found");
      await db.insert(tripExpenses).values({
        id,
        tenantId: actor.tenantId,
        tripId,
        category: input.category,
        amountCentavos: input.amountCentavos,
        incurredAt: new Date(input.incurredAt),
        note: input.note,
        status: "approved",
        companyBears: true,
        submittedBy: actor.userId,
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        reviewNote: "Entered by office staff",
        receiptKey: stored?.key,
        receiptMime: stored?.mime,
        receiptSha256: stored?.hash,
        receiptBytes: stored?.bytes,
        idempotencyKey: input.idempotencyKey,
      });
      await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "expense.add", entityType: "trip_expense", entityId: id, newValue: { tripId, category: input.category, amountCentavos: input.amountCentavos }, requestId: ctx.requestId });
      return { id, duplicate: false as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "That expense was already recorded");
    throw err;
  }
}

/** Approve (and decide who bears it) or reject a submitted expense. A decision is final. */
export async function reviewExpense(actor: TenantActor, expenseId: string, input: z.infer<typeof expenseReviewInput>, ctx: Ctx = {}) {
  authorize(actor, "expense:review");
  if (input.decision === "reject" && !input.note) throw new HttpError(400, "Say why it was rejected");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [e] = await db.select().from(tripExpenses).where(eq(tripExpenses.id, expenseId));
    if (!e) throw new HttpError(404, "Expense not found");
    const trip = await lockTrip(db, e.tripId);
    if (!trip) throw new HttpError(404, "Trip not found");
    const [fresh] = await db.select().from(tripExpenses).where(eq(tripExpenses.id, expenseId));
    if (fresh.status !== "submitted") throw new HttpError(409, "This expense was already decided");
    const bears = input.decision === "approve" ? (input.companyBears ?? defaultCompanyBears(e.category, { fuel: trip.fuelIncluded, toll: trip.tollIncluded })) : false;
    await db
      .update(tripExpenses)
      .set({ status: input.decision === "approve" ? "approved" : "rejected", companyBears: bears, reviewedBy: actor.userId, reviewedAt: new Date(), reviewNote: input.note ?? null })
      .where(eq(tripExpenses.id, expenseId));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: `expense.${input.decision}`, entityType: "trip_expense", entityId: expenseId, oldValue: { status: "submitted" }, newValue: { companyBears: bears, note: input.note ?? null }, requestId: ctx.requestId });
    await emitEvent(db, { type: "expense.reviewed", tenantId: actor.tenantId, tripId: e.tripId, expenseId, decision: input.decision === "approve" ? "approved" : "rejected", note: input.note ?? null });
    return { status: input.decision === "approve" ? ("approved" as const) : ("rejected" as const), companyBears: bears };
  });
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function shape(e: typeof tripExpenses.$inferSelect, who: { submitter: string | null; reviewer: string | null }, tripRef?: string) {
  return {
    id: e.id,
    tripId: e.tripId,
    tripReference: tripRef ?? null,
    category: e.category,
    amountCentavos: e.amountCentavos,
    incurredAt: iso(e.incurredAt),
    note: e.note,
    status: e.status,
    companyBears: e.companyBears,
    submittedByName: who.submitter,
    reviewedByName: who.reviewer,
    reviewNote: e.reviewNote,
    receiptUrl: e.receiptKey ? storage.signedUrl(e.receiptKey, 300) : null,
  };
}

/** Expenses awaiting a decision, across all trips (finance reviewers). */
export async function listExpensesToReview(actor: TenantActor) {
  authorize(actor, "expense:review");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ e: tripExpenses, ref: trips.reference, customer: customers.name, name: users.name })
      .from(tripExpenses)
      .innerJoin(trips, eq(trips.id, tripExpenses.tripId))
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .innerJoin(users, eq(users.id, tripExpenses.submittedBy))
      .where(eq(tripExpenses.status, "submitted"))
      .orderBy(desc(tripExpenses.createdAt));
    return rows.map((r) => ({ ...shape(r.e, { submitter: r.name, reviewer: null }, r.ref), customerName: r.customer }));
  });
}

/** All expenses of one trip, for finance staff. */
export async function listTripExpenses(actor: TenantActor, tripId: string) {
  authorize(actor, "finance:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db.select().from(tripExpenses).where(eq(tripExpenses.tripId, tripId)).orderBy(desc(tripExpenses.createdAt));
    const ids = [...new Set(rows.flatMap((r) => [r.submittedBy, r.reviewedBy].filter((x): x is string => !!x)))];
    const names = new Map<string, string>();
    for (const id of ids) {
      const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
      if (u) names.set(id, u.name);
    }
    return rows.map((r) => shape(r, { submitter: names.get(r.submittedBy) ?? null, reviewer: r.reviewedBy ? (names.get(r.reviewedBy) ?? null) : null }));
  });
}

/** A driver's own expenses on one trip (never anyone else's). */
export async function listMyTripExpenses(actor: TenantActor, tripId: string) {
  authorize(actor, "expense:submit");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select()
      .from(tripExpenses)
      .where(and(eq(tripExpenses.tripId, tripId), eq(tripExpenses.submittedBy, actor.userId)))
      .orderBy(desc(tripExpenses.createdAt));
    return rows.map((r) => shape(r, { submitter: null, reviewer: null }));
  });
}
