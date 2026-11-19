import { z } from "zod";
import { normalizePhPhone } from "./phone";
import { TRUCK_TYPES } from "./truck-types";

/** The six photos every applicant must upload. */
export const APPLICATION_PHOTOS = [
  { kind: "left", label: "Left side of the truck" },
  { kind: "right", label: "Right side of the truck" },
  { kind: "front", label: "Front of the truck" },
  { kind: "back", label: "Back of the truck" },
  { kind: "plate", label: "Plate number (close-up)" },
  { kind: "license", label: "Driver's license" },
] as const;
export type PhotoKind = (typeof APPLICATION_PHOTOS)[number]["kind"];
export const PHOTO_KINDS = APPLICATION_PHOTOS.map((p) => p.kind) as [PhotoKind, ...PhotoKind[]];
export const photoLabel = (k: string) => APPLICATION_PHOTOS.find((p) => p.kind === k)?.label ?? k;

/** Body sizes people quote when booking a truck. "Other" lets the applicant type their own. */
export const TRUCK_SIZES = ["10ft", "12ft", "14ft", "16ft", "18ft", "20ft", "Other"] as const;
export const OTHER = "Other";

const text = (max: number) => z.string().trim().min(1).max(max);

const truckFields = {
  plateNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9 -]{3,11}$/, "Enter the plate number, for example NBC 1234"),
  truckType: z.enum([...TRUCK_TYPES, OTHER]),
  truckTypeOther: z.string().trim().max(100).optional(),
  truckSize: z.enum(TRUCK_SIZES),
  truckSizeOther: z.string().trim().max(50).optional(),
  capacityKg: z.coerce.number().int().min(100).max(100_000).optional(),
  driverName: text(200),
  licenseNumber: z.string().trim().max(40).optional(),
  licenseExpiry: z.string().regex(/^d{4}-d{2}-d{2}$/, "Use the date on the license").optional(),
};

const otherChecks = (v: { truckType: string; truckTypeOther?: string; truckSize: string; truckSizeOther?: string }, ctx: z.RefinementCtx) => {
  if (v.truckType === OTHER && !v.truckTypeOther) ctx.addIssue({ code: "custom", path: ["truckTypeOther"], message: "Tell us what type of truck it is" });
  if (v.truckSize === OTHER && !v.truckSizeOther) ctx.addIssue({ code: "custom", path: ["truckSizeOther"], message: "Tell us the size of the truck" });
};

/** One truck and its driver. An owner with several units sends one of these per unit. */
export const truckInput = z.object(truckFields).superRefine(otherChecks);
export type TruckApplicationInput = z.infer<typeof truckInput>;
export const MAX_EXTRA_TRUCKS = 9;

export const applicationInput = z
  .object({
    companyName: text(200),
    contactName: text(200),
    phone: z.string().trim().transform((v, ctx) => {
      const n = normalizePhPhone(v);
      if (!n) ctx.addIssue({ code: "custom", message: "Enter a Philippine mobile number, for example 0917 123 4567" });
      return n ?? "";
    }),
    email: z.string().trim().toLowerCase().email().max(200),
    address: z.string().trim().max(500).optional(),
    ...truckFields,
    /** More units beyond the first. Each has its own six photos. */
    extraTrucks: z.array(truckInput).max(MAX_EXTRA_TRUCKS).default([]),
    notes: z.string().trim().max(1000).optional(),
    /** A honeypot: people never see this field, so anything in it means a bot. */
    website: z.string().max(200).optional(),
  })
  .superRefine((v, ctx) => {
    otherChecks(v, ctx);
    const plates = [v.plateNumber, ...v.extraTrucks.map((t) => t.plateNumber)];
    if (new Set(plates).size !== plates.length) ctx.addIssue({ code: "custom", path: ["extraTrucks"], message: "Each truck needs its own plate number" });
  });
export type ApplicationInput = z.infer<typeof applicationInput>;

/** Form field name of a photo: the first truck uses the plain kind, further trucks are t1_left, t2_front... */
export const photoField = (truckIndex: number, kind: string) => (truckIndex === 0 ? kind : `t${truckIndex}_${kind}`);

export const reviewApplicationInput = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() });
