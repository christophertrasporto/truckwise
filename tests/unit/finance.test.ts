import { describe, expect, it } from "vitest";
import { computeProfit, defaultCompanyBears, vatOn } from "@/shared/finance";

describe("vatOn", () => {
  it("rounds half up to the centavo and is exact for round numbers", () => {
    expect(vatOn(1_000_000, 1200)).toBe(120_000);
    expect(vatOn(12_345, 1200)).toBe(1_481); // 1481.4 -> 1481
    expect(vatOn(12_350, 1200)).toBe(1_482); // 1482.0
    expect(vatOn(5, 1200)).toBe(1); // 0.6 -> 1
    expect(vatOn(1_000_000, 0)).toBe(0);
  });
});

describe("computeProfit", () => {
  const exp = (amountCentavos: number, status: "submitted" | "approved" | "rejected", companyBears: boolean) => ({ amountCentavos, status, companyBears });

  it("trip profit = charge - partner payout - company-borne approved expenses", () => {
    const p = computeProfit({
      revenueCentavos: 10_000_000,
      payoutCentavos: 7_000_000,
      assignedTo: "partner",
      expenses: [exp(300_000, "approved", true), exp(200_000, "approved", true)],
    });
    expect(p).toMatchObject({ partnerPayoutCentavos: 7_000_000, driverPayCentavos: 0, directExpensesCentavos: 500_000, profitCentavos: 2_500_000, marginBps: 2500, costsKnown: true });
  });

  it("keeps driver pay and partner cost apart: an internal trip charges driver pay, not partner payout", () => {
    const p = computeProfit({ revenueCentavos: 5_000_000, payoutCentavos: 1_400_000, assignedTo: "internal", expenses: [] });
    expect(p).toMatchObject({ partnerPayoutCentavos: 0, driverPayCentavos: 1_400_000, profitCentavos: 3_600_000 });
  });

  it("does not count rejected, undecided or non-company expenses", () => {
    const p = computeProfit({
      revenueCentavos: 1_000_000,
      payoutCentavos: 600_000,
      assignedTo: "partner",
      expenses: [exp(50_000, "rejected", true), exp(70_000, "submitted", true), exp(30_000, "approved", false), exp(10_000, "approved", true)],
    });
    expect(p.directExpensesCentavos).toBe(10_000);
    expect(p.pendingExpensesCentavos).toBe(70_000);
    expect(p.profitCentavos).toBe(390_000);
  });

  it("an unassigned trip has no payout cost yet and says so; a loss is negative with a negative margin", () => {
    expect(computeProfit({ revenueCentavos: 100, payoutCentavos: 60, assignedTo: null, expenses: [] })).toMatchObject({ costsKnown: false, profitCentavos: 100 });
    const loss = computeProfit({ revenueCentavos: 1_000_000, payoutCentavos: 1_200_000, assignedTo: "partner", expenses: [] });
    expect(loss.profitCentavos).toBe(-200_000);
    expect(loss.marginBps).toBe(-2000);
    expect(computeProfit({ revenueCentavos: 0, payoutCentavos: 0, assignedTo: null, expenses: [] }).marginBps).toBeNull();
  });
});

describe("defaultCompanyBears", () => {
  it("fuel and tolls are the operator's own when the payout includes them", () => {
    expect(defaultCompanyBears("fuel", { fuel: true, toll: false })).toBe(false);
    expect(defaultCompanyBears("fuel", { fuel: false, toll: false })).toBe(true);
    expect(defaultCompanyBears("toll", { fuel: false, toll: true })).toBe(false);
    expect(defaultCompanyBears("repair", { fuel: true, toll: true })).toBe(true);
  });
});
