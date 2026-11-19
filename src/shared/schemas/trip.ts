import { z } from "zod";
import { TRUCK_TYPES } from "../truck-types";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v ? v : undefined))
    .optional();

/** Money crosses the API as integer centavos. The form converts pesos to centavos before sending. */
const centavos = z.number().int().min(0).max(100_000_000_00);

export const stopInput = z.object({
  kind: z.enum(["pickup", "delivery"]),
  address: z.string().trim().min(3).max(500),
  requiredArrivalAt: z.string().datetime({ offset: true }).optional(),
});

export const createTripInput = z
  .object({
    customerId: z.string().uuid(),
    reference: z.string().trim().min(1).max(60),
    cargoDescription: z.string().trim().min(1).max(500),
    cargoType: optionalText(100),
    weightKg: z.number().int().min(0).max(1_000_000).optional(),
    quantity: z.number().int().min(0).max(1_000_000).optional(),
    truckRequirement: z.enum(TRUCK_TYPES).optional(),
    handlingInstructions: optionalText(1000),
    notes: optionalText(2000),
    contractRateCentavos: centavos,
    /** Pay for the company's own driver. */
    payoutCentavos: centavos,
    /** Pay for a subcontractor, when different. Blank means the same as the driver pay. */
    subcontractorPayoutCentavos: centavos.optional(),
    /** Pay for a helper on the company's own trucks. */
    helperPayCentavos: centavos.optional(),
    fuelIncluded: z.boolean().default(false),
    tollIncluded: z.boolean().default(false),
    stops: z.array(stopInput).min(2).max(20),
  })
  .refine((v) => v.stops[0].kind === "pickup", { message: "First stop must be a pickup", path: ["stops"] })
  .refine((v) => v.stops[v.stops.length - 1].kind === "delivery", {
    message: "Last stop must be a delivery",
    path: ["stops"],
  });
export type CreateTripInput = z.infer<typeof createTripInput>;

export const OFFER_MODES = ["broadcast_internal", "broadcast_partners", "broadcast_all", "selected", "direct", "applicants"] as const;

export const offerInput = z
  .object({
    mode: z.enum(OFFER_MODES),
    /** direct: one internal driver ... */
    driverUserId: z.string().uuid().optional(),
    /** ... or one approved subcontractor company. */
    partnerTenantId: z.string().uuid().optional(),
    /** selected: the internal drivers who receive it. */
    userIds: z.array(z.string().uuid()).max(100).optional(),
    /** applicants: who may express interest. */
    audience: z.enum(["internal", "partners", "all"]).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "direct" && !!v.driverUserId === !!v.partnerTenantId) {
      ctx.addIssue({ code: "custom", path: ["driverUserId"], message: "Choose exactly one driver or one subcontractor" });
    }
    if (v.mode === "selected" && !(v.userIds && v.userIds.length > 0)) {
      ctx.addIssue({ code: "custom", path: ["userIds"], message: "Choose at least one driver" });
    }
    if (v.mode === "applicants" && !v.audience) {
      ctx.addIssue({ code: "custom", path: ["audience"], message: "Choose who may apply" });
    }
  });
export type OfferInput = z.infer<typeof offerInput>;

export const boardFilters = z.object({
  location: z.string().trim().max(100).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  truckType: z.enum(TRUCK_TYPES).optional(),
  minPayoutCentavos: z.coerce.number().int().min(0).optional(),
});
export type BoardFilters = z.infer<typeof boardFilters>;

export const claimInput = z.object({ truckId: z.string().uuid() });
export const partnerAcceptInput = z.object({ truckId: z.string().uuid(), driverUserId: z.string().uuid() });
export const decideInput = z.object({ decision: z.enum(["approve", "decline"]), reason: optionalText(500) });
export const reassignInput = z.object({ reason: z.string().trim().min(3).max(500) });

export const advanceInput = z.object({
  to: z.enum(["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"]),
});

export const podInput = z
  .object({
    outcome: z.enum(["complete", "partial", "discrepancy", "failed"]),
    receiverName: z.string().trim().min(1).max(200),
    deliveredQuantity: z.coerce.number().int().min(0).max(1_000_000).optional(),
    discrepancyNotes: optionalText(2000),
    comments: optionalText(2000),
    /** When the driver says the delivery happened. Distinct from the server's upload time. */
    actualDeliveryAt: z.string().datetime({ offset: true }),
    gpsConsent: z.enum(["granted", "denied", "unavailable"]).default("unavailable"),
    gpsLat: z.coerce.number().min(-90).max(90).optional(),
    gpsLng: z.coerce.number().min(-180).max(180).optional(),
    gpsAccuracyM: z.coerce.number().min(0).max(100_000).optional(),
    idempotencyKey: z.string().min(8).max(100),
    /** Which delivery stop this proof is for. Optional only when the trip has a single delivery stop. */
    stopId: z.string().uuid().optional(),
    /** Set by the phone when the submission waited in its offline queue. */
    submittedOffline: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    /** The phone's own clock when it queued the submission. Reported, never verified. */
    deviceQueuedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => v.outcome === "complete" || !!v.discrepancyNotes, {
    message: "Describe what was short, damaged, missing or why delivery failed",
    path: ["discrepancyNotes"],
  });
export type PodInput = z.infer<typeof podInput>;

export const reviewInput = z.object({
  decision: z.enum(["approve", "reject", "request_more"]),
  reason: optionalText(1000),
});

export const memberInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(200),
  role: z.enum(["ops_manager", "dispatcher", "accountant", "driver", "sub_manager", "sub_driver"]),
  password: z.string().min(10).max(200),
});

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(200),
});
