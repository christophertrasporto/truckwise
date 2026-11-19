/** Pure finance rules. Money is always integer centavos; nothing here touches floats except the single rounding step. */

/** VAT on a subtotal, rounded half up to the nearest centavo. bps = basis points (1200 = 12%). */
export function vatOn(subtotalCentavos: number, bps: number): number {
  return Math.round((subtotalCentavos * bps) / 10_000);
}

export interface ProfitInput {
  /** What the customer is charged for the trip. */
  revenueCentavos: number;
  /** The agreed payout on the trip for whoever does it (the subcontractor's rate, or the own driver's pay). */
  payoutCentavos: number;
  /** Helper pay on the company's own trucks. Zero when a subcontractor does the trip. */
  helperPayCentavos?: number;
  /** Who is doing the job: null until assigned. */
  assignedTo: "internal" | "partner" | null;
  expenses: { status: "submitted" | "approved" | "rejected"; companyBears: boolean; amountCentavos: number }[];
}

export interface Profit {
  revenueCentavos: number;
  /** Cost of a subcontractor doing the trip (the payout agreed with them). */
  partnerPayoutCentavos: number;
  /** Cost of a company driver doing the trip (their payout). Kept apart from the partner cost. */
  driverPayCentavos: number;
  /** Helper pay on an own-truck trip. */
  helperPayCentavos: number;
  /** Approved expenses the company bears (fuel, tolls and so on). */
  directExpensesCentavos: number;
  /** Submitted but not yet decided: shown, not counted. */
  pendingExpensesCentavos: number;
  /** False until the trip is assigned: the payout is then not yet a real cost. */
  costsKnown: boolean;
  /** Revenue minus partner payout, driver pay and direct expenses. Before overhead and taxes. */
  profitCentavos: number;
  /** Profit as a share of revenue in basis points (2500 = 25.00%), or null with no revenue. */
  marginBps: number | null;
}

/**
 * Trip profit = customer charge - partner payout - driver pay - approved company-borne expenses
 * (before overhead and taxes). Only one of partner payout / driver pay applies to a given trip.
 * Rejected expenses, expenses someone else bears and undecided expenses never reduce profit.
 */
export function computeProfit(i: ProfitInput): Profit {
  const partnerPayoutCentavos = i.assignedTo === "partner" ? i.payoutCentavos : 0;
  const driverPayCentavos = i.assignedTo === "internal" ? i.payoutCentavos : 0;
  const helperPayCentavos = i.assignedTo === "internal" ? (i.helperPayCentavos ?? 0) : 0;
  const directExpensesCentavos = i.expenses.filter((e) => e.status === "approved" && e.companyBears).reduce((n, e) => n + e.amountCentavos, 0);
  const pendingExpensesCentavos = i.expenses.filter((e) => e.status === "submitted").reduce((n, e) => n + e.amountCentavos, 0);
  const profitCentavos = i.revenueCentavos - partnerPayoutCentavos - driverPayCentavos - helperPayCentavos - directExpensesCentavos;
  return {
    revenueCentavos: i.revenueCentavos,
    partnerPayoutCentavos,
    driverPayCentavos,
    helperPayCentavos,
    directExpensesCentavos,
    pendingExpensesCentavos,
    costsKnown: i.assignedTo !== null,
    profitCentavos,
    marginBps: i.revenueCentavos > 0 ? Math.round((profitCentavos * 10_000) / i.revenueCentavos) : null,
  };
}

/**
 * Who should carry an expense by default. A fuel or toll cost is the operator's own when the agreed payout
 * already includes it; otherwise the company bears it. Everything else defaults to the company. A reviewer can override.
 */
export function defaultCompanyBears(category: string, payoutIncludes: { fuel: boolean; toll: boolean }): boolean {
  if (category === "fuel") return !payoutIncludes.fuel;
  if (category === "toll") return !payoutIncludes.toll;
  return true;
}
