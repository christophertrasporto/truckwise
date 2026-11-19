import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { vatOn } from "@/shared/finance";
import { writeAudit } from "../../audit";
import { withTenant, type Db } from "../../db";
import {
  companySettings,
  customers,
  epodAttachmentProcessing,
  epodAttachments,
  epodSubmissions,
  invoiceLines,
  invoices,
  podReviews,
  tenants,
  tripStops,
  trips,
  users,
} from "../../db/schema";
import { HttpError, isUniqueViolation } from "../../errors";
import { authorize } from "../../policy";
import { storage } from "../../storage";
import type { Ctx, TenantActor } from "../trips";
import { nextDocumentNumber } from "./shared";

export const generateInvoiceInput = z.object({
  customerId: z.string().uuid(),
  tripIds: z.array(z.string().uuid()).min(1).max(200),
  idempotencyKey: z.string().min(8).max(100),
  notes: z.string().trim().max(1000).optional(),
});
export type GenerateInvoiceInput = z.infer<typeof generateInvoiceInput>;

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

/** Finished trips that no active invoice covers, grouped by customer: what the accountant can bill now. */
export async function invoiceableTrips(actor: TenantActor) {
  authorize(actor, "finance:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ trip: trips, customerName: customers.name })
      .from(trips)
      .innerJoin(customers, eq(customers.id, trips.customerId))
      .where(eq(trips.status, "ready_for_invoice"))
      .orderBy(asc(trips.createdAt));
    const billed = new Set(
      (await db.select({ tripId: invoiceLines.tripId }).from(invoiceLines).where(eq(invoiceLines.active, true))).map((l) => l.tripId),
    );
    const open = rows.filter((r) => !billed.has(r.trip.id));
    const routes = await routeLabels(db, open.map((r) => r.trip.id));
    const byCustomer = new Map<string, { customerId: string; customerName: string; trips: { id: string; reference: string; route: string; amountCentavos: number }[]; subtotalCentavos: number }>();
    for (const r of open) {
      const g = byCustomer.get(r.trip.customerId) ?? { customerId: r.trip.customerId, customerName: r.customerName, trips: [], subtotalCentavos: 0 };
      g.trips.push({ id: r.trip.id, reference: r.trip.reference, route: routes.get(r.trip.id) ?? "", amountCentavos: r.trip.contractRateCentavos });
      g.subtotalCentavos += r.trip.contractRateCentavos;
      byCustomer.set(r.trip.customerId, g);
    }
    return [...byCustomer.values()];
  });
}

/**
 * Issue an invoice for finished trips of one customer, with each trip's customer rate fixed at this moment.
 * Safe to repeat: the same idempotency key returns the same invoice, and a trip already on an active invoice
 * is refused (the trip rows are locked first, and a unique index backs it), so nothing is ever billed twice.
 */
export async function generateInvoice(actor: TenantActor, input: GenerateInvoiceInput, ctx: Ctx = {}) {
  authorize(actor, "invoice:manage");
  const tripIds = [...new Set(input.tripIds)].sort();
  try {
    return await withTenant(actor.tenantId, actor.userId, async (db) => {
      const [existing] = await db.select().from(invoices).where(eq(invoices.idempotencyKey, input.idempotencyKey));
      if (existing) return { id: existing.id, number: existing.number, duplicate: true as const };

      const [customer] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId));
      if (!customer) throw new HttpError(400, "Unknown client");
      // Lock in a fixed order so two people billing overlapping trips cannot deadlock.
      const rows = await db.select().from(trips).where(inArray(trips.id, tripIds)).orderBy(asc(trips.id)).for("update");
      if (rows.length !== tripIds.length) throw new HttpError(404, "One of the trips was not found");
      const wrongCustomer = rows.filter((t) => t.customerId !== input.customerId);
      if (wrongCustomer.length) throw new HttpError(400, `Different client: ${wrongCustomer.map((t) => t.reference).join(", ")}`);
      const notReady = rows.filter((t) => t.status !== "ready_for_invoice");
      if (notReady.length) throw new HttpError(409, `Not ready for invoice: ${notReady.map((t) => t.reference).join(", ")}`);
      const already = await db.select({ tripId: invoiceLines.tripId }).from(invoiceLines).where(and(inArray(invoiceLines.tripId, tripIds), eq(invoiceLines.active, true)));
      if (already.length) {
        const refs = rows.filter((t) => already.some((a) => a.tripId === t.id)).map((t) => t.reference);
        throw Object.assign(new HttpError(409, `Already invoiced: ${refs.join(", ")}`), { code: "already_invoiced" });
      }

      const [settings] = await db.select({ vat: companySettings.vatBps }).from(companySettings).where(eq(companySettings.tenantId, actor.tenantId));
      const vatBps = settings?.vat ?? 0;
      const subtotal = rows.reduce((n, t) => n + t.contractRateCentavos, 0);
      const vat = vatOn(subtotal, vatBps);
      const number = await nextDocumentNumber(db, actor.tenantId, "invoice");
      const [inv] = await db
        .insert(invoices)
        .values({
          tenantId: actor.tenantId,
          number,
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
          subtotalCentavos: subtotal,
          vatBps,
          vatCentavos: vat,
          totalCentavos: subtotal + vat,
          notes: input.notes,
          createdBy: actor.userId,
        })
        .returning();
      const routes = await routeLabels(db, tripIds);
      await db.insert(invoiceLines).values(
        rows.map((t) => ({
          tenantId: actor.tenantId,
          invoiceId: inv.id,
          tripId: t.id,
          description: `${t.reference}: ${routes.get(t.id)} (${t.cargoDescription})`,
          amountCentavos: t.contractRateCentavos,
        })),
      );
      await writeAudit(db, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "invoice.issue",
        entityType: "invoice",
        entityId: inv.id,
        newValue: { number, customerId: input.customerId, trips: rows.map((t) => t.reference), subtotalCentavos: subtotal, vatCentavos: vat, totalCentavos: subtotal + vat },
        requestId: ctx.requestId,
      });
      return { id: inv.id, number, duplicate: false as const };
    });
  } catch (err) {
    if (isUniqueViolation(err) || (err as { code?: string })?.code === "already_invoiced") {
      // Lost a race on the idempotency key (the same request sent twice at once): return the winner. Otherwise a trip was just billed.
      const winner = await withTenant(actor.tenantId, actor.userId, (db) => db.select().from(invoices).where(eq(invoices.idempotencyKey, input.idempotencyKey)));
      if (winner[0]) return { id: winner[0].id, number: winner[0].number, duplicate: true as const };
      if (isUniqueViolation(err)) throw Object.assign(new HttpError(409, "One of these trips was just invoiced"), { code: "already_invoiced" });
    }
    throw err;
  }
}

/** Bill every finished, not-yet-invoiced trip of a customer in one go. Running it again finds nothing to bill. */
export async function invoiceAllReady(actor: TenantActor, customerId: string, idempotencyKey: string, ctx: Ctx = {}) {
  authorize(actor, "invoice:manage");
  const [group] = (await invoiceableTrips(actor)).filter((g) => g.customerId === customerId);
  if (!group) {
    // A repeated request with the same key still returns the invoice it created.
    const replay = await withTenant(actor.tenantId, actor.userId, (db) => db.select().from(invoices).where(eq(invoices.idempotencyKey, idempotencyKey)));
    if (replay[0]) return { created: false as const, id: replay[0].id, number: replay[0].number };
    return { created: false as const, id: null, number: null };
  }
  const r = await generateInvoice(actor, { customerId, tripIds: group.trips.map((t) => t.id), idempotencyKey }, ctx);
  return { created: !r.duplicate, id: r.id, number: r.number };
}

export async function listInvoices(actor: TenantActor) {
  authorize(actor, "finance:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({ i: invoices, customerName: customers.name })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .orderBy(desc(invoices.issuedAt));
    return rows.map(({ i, customerName }) => ({
      id: i.id,
      number: i.number,
      customerName,
      status: i.status,
      totalCentavos: i.totalCentavos,
      issuedAt: iso(i.issuedAt),
      dueAt: iso(new Date(i.issuedAt.getTime() + i.paymentTermsDays * 86_400_000)),
      paidAt: iso(i.paidAt),
    }));
  });
}

/** The newest approved proof of every delivery stop of these trips, with short-lived links. Quarantined files are left out. */
export async function approvedProofFor(db: Db, tripIds: string[]) {
  if (tripIds.length === 0) return new Map<string, Awaited<ReturnType<typeof stopProofRows>>>();
  const out = new Map<string, Awaited<ReturnType<typeof stopProofRows>>>();
  const all = await stopProofRows(db, tripIds);
  for (const id of tripIds) out.set(id, all.filter((p) => p.tripId === id));
  return out;
}

async function stopProofRows(db: Db, tripIds: string[]) {
  const subs = await db
    .select({ s: epodSubmissions, seq: tripStops.seq, address: tripStops.address })
    .from(epodSubmissions)
    .leftJoin(tripStops, eq(tripStops.id, epodSubmissions.stopId))
    .where(and(inArray(epodSubmissions.tripId, tripIds), eq(epodSubmissions.status, "approved")))
    .orderBy(desc(epodSubmissions.version));
  // newest approved version per stop
  const seen = new Set<string>();
  const latest = subs.filter((x) => {
    const k = x.s.stopId ?? x.s.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (latest.length === 0) return [];
  const ids = latest.map((x) => x.s.id);
  const files = await db
    .select({ a: epodAttachments, p: epodAttachmentProcessing })
    .from(epodAttachments)
    .leftJoin(epodAttachmentProcessing, eq(epodAttachmentProcessing.attachmentId, epodAttachments.id))
    .where(inArray(epodAttachments.submissionId, ids));
  const reviews = await db
    .select({ r: podReviews, name: users.name })
    .from(podReviews)
    .leftJoin(users, eq(users.id, podReviews.reviewerUserId))
    .where(and(inArray(podReviews.submissionId, ids), eq(podReviews.decision, "approve")))
    .orderBy(desc(podReviews.createdAt));
  return latest
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map(({ s, seq, address }) => {
      const mine = files.filter((f) => f.a.submissionId === s.id && f.p?.scanStatus !== "infected");
      const file = (f: (typeof mine)[number]) => ({
        id: f.a.id,
        kind: f.a.kind as "photo" | "signature" | "pdf",
        filename: f.a.originalFilename,
        objectKey: f.a.objectKey,
        displayKey: f.p?.displayStatus === "ready" ? f.p.displayKey : null,
        url: storage.signedUrl(f.a.objectKey, 300),
        displayUrl: f.p?.displayStatus === "ready" && f.p.displayKey ? storage.signedUrl(f.p.displayKey, 300) : null,
      });
      const approval = reviews.find((r) => r.r.submissionId === s.id);
      return {
        tripId: s.tripId,
        stopSeq: seq ?? null,
        stopAddress: address ?? null,
        outcome: s.outcome,
        receiverName: s.receiverName,
        deliveredAt: iso(s.actualDeliveryAt),
        uploadedAt: iso(s.uploadedAt),
        approvedAt: iso(approval?.r.createdAt ?? null),
        approvedBy: approval ? (approval.r.automatic ? "Automatic approval (company policy)" : (approval.name ?? "")) : null,
        photos: mine.filter((f) => f.a.kind === "photo").map(file),
        signature: mine.filter((f) => f.a.kind === "signature").map(file)[0] ?? null,
        pdfs: mine.filter((f) => f.a.kind === "pdf").map(file),
      };
    });
}

/** An invoice with its lines and, for every trip billed, the approved proof of delivery. */
export async function getInvoice(actor: TenantActor, id: string) {
  authorize(actor, "finance:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [row] = await db
      .select({ i: invoices, customerName: customers.name, customerAddress: customers.address, tenantName: tenants.name })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .innerJoin(tenants, eq(tenants.id, invoices.tenantId))
      .where(eq(invoices.id, id));
    if (!row) throw new HttpError(404, "Invoice not found");
    const lines = await db
      .select({ l: invoiceLines, reference: trips.reference })
      .from(invoiceLines)
      .innerJoin(trips, eq(trips.id, invoiceLines.tripId))
      .where(eq(invoiceLines.invoiceId, id));
    const proof = await approvedProofFor(db, lines.map((l) => l.l.tripId));
    const i = row.i;
    return {
      id: i.id,
      number: i.number,
      status: i.status,
      company: row.tenantName,
      customerName: row.customerName,
      customerAddress: row.customerAddress,
      issuedAt: iso(i.issuedAt),
      dueAt: iso(new Date(i.issuedAt.getTime() + i.paymentTermsDays * 86_400_000)),
      paymentTermsDays: i.paymentTermsDays,
      paidAt: iso(i.paidAt),
      paymentReference: i.paymentReference,
      voidedAt: iso(i.voidedAt),
      voidReason: i.voidReason,
      notes: i.notes,
      subtotalCentavos: i.subtotalCentavos,
      vatBps: i.vatBps,
      vatCentavos: i.vatCentavos,
      totalCentavos: i.totalCentavos,
      lines: lines.map(({ l, reference }) => ({ id: l.id, tripId: l.tripId, reference, description: l.description, amountCentavos: l.amountCentavos, proof: proof.get(l.tripId) ?? [] })),
    };
  });
}

export const markPaidInput = z.object({ reference: z.string().trim().min(1).max(100), paidAt: z.string().datetime({ offset: true }).optional() });

export async function markInvoicePaid(actor: TenantActor, id: string, input: z.infer<typeof markPaidInput>, ctx: Ctx = {}) {
  authorize(actor, "invoice:manage");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id)).for("update");
    if (!inv) throw new HttpError(404, "Invoice not found");
    if (inv.status !== "issued") throw new HttpError(409, `This invoice is already ${inv.status}`);
    await db.update(invoices).set({ status: "paid", paidAt: input.paidAt ? new Date(input.paidAt) : new Date(), paymentReference: input.reference }).where(eq(invoices.id, id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "invoice.paid", entityType: "invoice", entityId: id, newValue: { reference: input.reference }, requestId: ctx.requestId });
  });
}

/** Void an unpaid invoice. Its trips become billable again. A paid invoice cannot be voided. */
export async function voidInvoice(actor: TenantActor, id: string, reason: string, ctx: Ctx = {}) {
  authorize(actor, "invoice:manage");
  if (reason.trim().length < 3) throw new HttpError(400, "Give a reason");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id)).for("update");
    if (!inv) throw new HttpError(404, "Invoice not found");
    if (inv.status !== "issued") throw new HttpError(409, `A ${inv.status} invoice cannot be voided`);
    await db.update(invoices).set({ status: "void", voidedAt: new Date(), voidedBy: actor.userId, voidReason: reason.trim() }).where(eq(invoices.id, id));
    await db.update(invoiceLines).set({ active: false }).where(eq(invoiceLines.invoiceId, id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "invoice.void", entityType: "invoice", entityId: id, oldValue: { number: inv.number, totalCentavos: inv.totalCentavos }, newValue: { reason: reason.trim() }, requestId: ctx.requestId });
  });
}
