import { describe, expect, it } from "vitest";
import { COST_CATEGORIES, quote } from "@/shared/costs";

describe("quote", () => {
  it("computes profit and margin from what the customer pays and what you offer", () => {
    const q = quote({ customerPaysCentavos: 20_000_00, offerCentavos: 15_000_00 });
    expect(q.profitCentavos).toBe(5_000_00);
    expect(q.marginBps).toBe(2500);
    expect(q.verdict).toBe("healthy");
  });

  it("subtracts costs you carry yourself", () => {
    const q = quote({ customerPaysCentavos: 20_000_00, offerCentavos: 15_000_00, yourCostsCentavos: 4_000_00 });
    expect(q.profitCentavos).toBe(1_000_00);
    expect(q.verdict).toBe("thin");
  });

  it("flags a loss", () => {
    const q = quote({ customerPaysCentavos: 10_000_00, offerCentavos: 11_000_00 });
    expect(q.profitCentavos).toBe(-1_000_00);
    expect(q.verdict).toBe("loss");
  });

  it("has no margin when the customer pays nothing", () => {
    expect(quote({ customerPaysCentavos: 0, offerCentavos: 0 }).marginBps).toBeNull();
  });

  it("finds the highest offer that keeps a target margin, never below zero", () => {
    const q = quote({ customerPaysCentavos: 20_000_00, offerCentavos: 0, yourCostsCentavos: 1_000_00 });
    expect(q.maxOfferForTargetCentavos(1500)).toBe(16_000_00);
    expect(quote({ customerPaysCentavos: 1_000_00, offerCentavos: 0, yourCostsCentavos: 5_000_00 }).maxOfferForTargetCentavos(1500)).toBe(0);
  });

  it("adds VAT to what the customer is billed but not to profit", () => {
    const q = quote({ customerPaysCentavos: 10_000_00, offerCentavos: 8_000_00, vatBps: 1200 });
    expect(q.billedToCustomerCentavos).toBe(11_200_00);
    expect(q.profitCentavos).toBe(2_000_00);
  });

  it("offers the expense types a trucking company tracks", () => {
    const keys = COST_CATEGORIES.map((c) => c.key);
    for (const k of ["diesel", "rfid", "maintenance", "salary"]) expect(keys).toContain(k);
  });
});
