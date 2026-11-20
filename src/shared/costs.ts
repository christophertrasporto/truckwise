/** What the business spends money on. Labels are what people see; the key is what is stored. */
export const COST_CATEGORIES = [
  { key: "diesel", label: "Diesel" },
  { key: "rfid", label: "RFID / toll tag load" },
  { key: "toll", label: "Toll (cash)" },
  { key: "maintenance", label: "Maintenance and repairs" },
  { key: "tires", label: "Tires" },
  { key: "salary", label: "Salary and wages" },
  { key: "insurance", label: "Insurance" },
  { key: "registration", label: "Registration and permits" },
  { key: "parking", label: "Parking" },
  { key: "loading", label: "Loading and unloading" },
  { key: "meals", label: "Driver meals and allowance" },
  { key: "office", label: "Office and overhead" },
  { key: "other", label: "Others" },
] as const;

export type CostCategory = (typeof COST_CATEGORIES)[number]["key"];
export const COST_KEYS = COST_CATEGORIES.map((c) => c.key) as [CostCategory, ...CostCategory[]];
export const costLabel = (key: string) => COST_CATEGORIES.find((c) => c.key === key)?.label ?? key;

/** Salaries are visible only to the owner and accountant. */
export const SENSITIVE_COSTS: readonly CostCategory[] = ["salary"];

// ---------------------------------------------------------------------------
// The quote: what the customer pays against what you offer, and what is left.
// ---------------------------------------------------------------------------

export interface QuoteInput {
  /** What the customer pays for the trip. */
  customerPaysCentavos: number;
  /** What you offer the subcontractor (or your own driver). */
  offerCentavos: number;
  /** Costs you expect to pay yourself on top (diesel, RFID, tolls you cover). Optional. */
  yourCostsCentavos?: number;
  /** VAT you charge the customer, in basis points. VAT is passed to the government, so it is not your income. */
  vatBps?: number;
}

export interface Quote {
  customerPaysCentavos: number;
  offerCentavos: number;
  yourCostsCentavos: number;
  /** Customer charge minus offer minus your own costs, before overhead and taxes. */
  profitCentavos: number;
  /** Profit as a share of the customer charge, in basis points. Null with no charge. */
  marginBps: number | null;
  /** Highest offer that still leaves the target margin. */
  maxOfferForTargetCentavos: (targetBps: number) => number;
  verdict: "loss" | "thin" | "healthy";
  /** The customer charge plus VAT, if charged: what the customer will actually be billed. */
  billedToCustomerCentavos: number;
}

/**
 * Quote check. Profit = customer pays - what you offer - the costs you carry yourself (before overhead and taxes).
 * "thin" means under 10% margin. The offer that would give a target margin is
 * floor(customerPays * (1 - target) - yourCosts), never below zero.
 */
export function quote(i: QuoteInput): Quote {
  const costs = i.yourCostsCentavos ?? 0;
  const profit = i.customerPaysCentavos - i.offerCentavos - costs;
  const margin = i.customerPaysCentavos > 0 ? Math.round((profit * 10_000) / i.customerPaysCentavos) : null;
  return {
    customerPaysCentavos: i.customerPaysCentavos,
    offerCentavos: i.offerCentavos,
    yourCostsCentavos: costs,
    profitCentavos: profit,
    marginBps: margin,
    maxOfferForTargetCentavos: (target) => Math.max(0, Math.floor((i.customerPaysCentavos * (10_000 - target)) / 10_000 - costs)),
    verdict: profit < 0 ? "loss" : margin !== null && margin < 1000 ? "thin" : "healthy",
    billedToCustomerCentavos: i.customerPaysCentavos + Math.round((i.customerPaysCentavos * (i.vatBps ?? 0)) / 10_000),
  };
}
