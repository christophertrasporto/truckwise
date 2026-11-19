import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../../audit";
import { withTenant } from "../../db";
import { invoiceLines, settlementLines, trips } from "../../db/schema";
import { HttpError } from "../../errors";
import { authorize } from "../../policy";
import { lockTrip, type Ctx, type TenantActor } from "../trips";

const centavos = z.number().int().min(0).max(100_000_000_00);
export const moneyEditInput = z
  .object({
    contractRateCentavos: centavos.optional(),
    payoutCentavos: centavos.optional(),
    /** null clears it: a subcontractor is then paid the standard payout. */
    subcontractorPayoutCentavos: centavos.nullable().optional(),
    helperPayCentavos: centavos.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((v) => v.contractRateCentavos !== undefined || v.payoutCentavos !== undefined || v.subcontractorPayoutCentavos !== undefined || v.helperPayCentavos !== undefined, { message: "Change the customer rate or a payout" });

/**
 * Change a trip's customer rate and/or payout. Every change is audited with old and new values and a reason.
 * A rate cannot change once the trip is on an active invoice, nor a payout once it is on an active settlement:
 * void that document first.
 */
export async function updateTripMoney(actor: TenantActor, tripId: string, input: z.infer<typeof moneyEditInput>, ctx: Ctx = {}) {
  authorize(actor, "money:edit");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const trip = await lockTrip(db, tripId);
    if (!trip) throw new HttpError(404, "Trip not found");
    if (trip.status === "cancelled") throw new HttpError(409, "A cancelled trip cannot be changed");
    const rateChanges = input.contractRateCentavos !== undefined && input.contractRateCentavos !== trip.contractRateCentavos;
    const payoutChanges = input.payoutCentavos !== undefined && input.payoutCentavos !== trip.payoutCentavos;
    const subChanges = input.subcontractorPayoutCentavos !== undefined && input.subcontractorPayoutCentavos !== trip.subcontractorPayoutCentavos;
    const helperChanges = input.helperPayCentavos !== undefined && input.helperPayCentavos !== trip.helperPayCentavos;
    if (!rateChanges && !payoutChanges && !subChanges && !helperChanges) throw new HttpError(400, "Nothing changed");

    if (rateChanges) {
      const [l] = await db.select({ id: invoiceLines.id }).from(invoiceLines).where(and(eq(invoiceLines.tripId, tripId), eq(invoiceLines.active, true)));
      if (l) throw new HttpError(409, "This trip is on an invoice. Void the invoice before changing the customer rate.");
    }
    if (payoutChanges || subChanges) {
      const [l] = await db.select({ id: settlementLines.id }).from(settlementLines).where(and(eq(settlementLines.tripId, tripId), eq(settlementLines.active, true)));
      if (l) throw new HttpError(409, "This trip is on a settlement. Void the settlement before changing the payout.");
    }
    const next = {
      contractRateCentavos: rateChanges ? input.contractRateCentavos! : trip.contractRateCentavos,
      payoutCentavos: payoutChanges ? input.payoutCentavos! : trip.payoutCentavos,
    };
    // The new pay fields appear in the record only when they were part of this change, so older entries keep their shape.
    const before: Record<string, number | null> = { contractRateCentavos: trip.contractRateCentavos, payoutCentavos: trip.payoutCentavos };
    const after: Record<string, number | null> = { ...next };
    if (subChanges) {
      before.subcontractorPayoutCentavos = trip.subcontractorPayoutCentavos;
      after.subcontractorPayoutCentavos = input.subcontractorPayoutCentavos ?? null;
    }
    if (helperChanges) {
      before.helperPayCentavos = trip.helperPayCentavos;
      after.helperPayCentavos = input.helperPayCentavos!;
    }
    await db
      .update(trips)
      .set({ ...next, ...(subChanges ? { subcontractorPayoutCentavos: input.subcontractorPayoutCentavos ?? null } : {}), ...(helperChanges ? { helperPayCentavos: input.helperPayCentavos! } : {}), updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    await writeAudit(db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "trip.money",
      entityType: "trip",
      entityId: tripId,
      oldValue: before,
      newValue: { ...after, reason: input.reason },
      requestId: ctx.requestId,
    });
    return after;
  });
}
