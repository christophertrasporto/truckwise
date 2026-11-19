import type { InferSelectModel } from "drizzle-orm";
import type { trips } from "../db/schema";

type TripRow = InferSelectModel<typeof trips>;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Audience-specific serializers. Fields are picked one by one on purpose: never spread a DB row,
 * so a column added later cannot leak to the wrong audience by default.
 */

/** Dispatch/finance staff: everything, including the customer contract rate. */
export function staffTrip(t: TripRow, customerName: string) {
  return {
    id: t.id,
    reference: t.reference,
    status: t.status,
    customerId: t.customerId,
    customerName,
    cargoDescription: t.cargoDescription,
    cargoType: t.cargoType,
    weightKg: t.weightKg,
    quantity: t.quantity,
    truckRequirement: t.truckRequirement,
    handlingInstructions: t.handlingInstructions,
    notes: t.notes,
    contractRateCentavos: t.contractRateCentavos,
    payoutCentavos: t.payoutCentavos,
    subcontractorPayoutCentavos: t.subcontractorPayoutCentavos,
    helperPayCentavos: t.helperPayCentavos,
    fuelIncluded: t.fuelIncluded,
    tollIncluded: t.tollIncluded,
    createdAt: iso(t.createdAt),
  };
}

/** Drivers and subcontractors: payout only. The contract rate is not selected into this shape at all. */
export function driverTrip(t: TripRow, customerName: string) {
  return {
    id: t.id,
    reference: t.reference,
    status: t.status,
    customerName,
    cargoDescription: t.cargoDescription,
    cargoType: t.cargoType,
    weightKg: t.weightKg,
    quantity: t.quantity,
    truckRequirement: t.truckRequirement,
    handlingInstructions: t.handlingInstructions,
    notes: t.notes,
    payoutCentavos: t.payoutCentavos,
    fuelIncluded: t.fuelIncluded,
    tollIncluded: t.tollIncluded,
  };
}

/** What a subcontractor is paid for a trip: its own rate when one was set, otherwise the standard payout. */
export const subcontractorPayout = (t: { payoutCentavos: number; subcontractorPayoutCentavos: number | null }) => t.subcontractorPayoutCentavos ?? t.payoutCentavos;

/** A subcontractor company: the same fields as a driver sees, with the subcontractor's own rate as the payout. */
export function partnerTrip(t: TripRow, customerName: string) {
  return { ...driverTrip(t, customerName), payoutCentavos: subcontractorPayout(t) };
}

/**
 * A subcontractor's own driver: no money at all. The payout is between the partner company and the
 * hauler, and what the partner pays its driver is theirs to settle.
 */
export function subDriverTrip(t: TripRow, customerName: string) {
  const { payoutCentavos, fuelIncluded, tollIncluded, ...rest } = driverTrip(t, customerName);
  void payoutCentavos;
  void fuelIncluded;
  void tollIncluded;
  return rest;
}
