import { z } from "zod";

/** Things a plan can switch on or off. Anything not listed here cannot be a flag. */
export const PLAN_FEATURES = [
  { key: "costs", label: "Cost ledger (diesel, RFID, maintenance, salary)" },
  { key: "pnl", label: "Company profit and loss" },
  { key: "applications", label: "Public subcontractor application form" },
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number]["key"];
export const FEATURE_KEYS = PLAN_FEATURES.map((f) => f.key) as [PlanFeature, ...PlanFeature[]];

const limit = z.number().int().min(1).max(100_000).nullable();

export const planInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  priceCentavos: z.number().int().min(0).max(100_000_000_00),
  periodMonths: z.number().int().refine((n) => n === 1 || n === 3 || n === 12, "Choose 1, 3 or 12 months"),
  maxTrucks: limit,
  maxDrivers: limit,
  maxUsers: limit,
  features: z.record(z.enum(FEATURE_KEYS), z.boolean()),
  active: z.boolean().default(true),
});
export type PlanInput = z.infer<typeof planInput>;

export const createCompanyInput = z.object({
  companyName: z.string().trim().min(2).max(200),
  ownerName: z.string().trim().min(2).max(200),
  ownerEmail: z.string().trim().toLowerCase().email().max(200),
  planId: z.string().uuid(),
  /** Days of free trial before the first payment is due. */
  trialDays: z.number().int().min(0).max(90).default(14),
});

export const recordPaymentInput = z.object({
  amountCentavos: z.number().int().min(1).max(100_000_000_00),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-19"),
  method: z.string().trim().max(60).optional(),
  reference: z.string().trim().max(120).optional(),
  periodsAdded: z.number().int().min(1).max(24).default(1),
  idempotencyKey: z.string().min(8).max(100),
});

export const changePlanInput = z.object({ planId: z.string().uuid() });
export const setCompanyStatusInput = z.object({ status: z.enum(["active", "suspended"]), reason: z.string().trim().min(3).max(300) });
