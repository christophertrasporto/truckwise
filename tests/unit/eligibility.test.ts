import { describe, expect, it } from "vitest";
import { evaluateEligibility, tripWindow, type EligibilityFacts } from "@/shared/eligibility";

const now = new Date("2026-06-01T00:00:00Z");
const base = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  trip: { truckRequirement: "10-wheeler", weightKg: 8000, windowStart: new Date("2026-06-10T01:00:00Z"), windowEnd: new Date("2026-06-10T11:00:00Z") },
  truck: { truckType: "10-wheeler", capacityKg: 12000, status: "active", registrationExpiry: "2026-12-31", inspectionExpiry: "2026-12-31" },
  driver: { licenseNumber: "N01-23-456789", licenseExpiry: "2027-01-01" },
  driverBusy: false,
  truckBusy: false,
  now,
  ...over,
});
const codes = (f: EligibilityFacts) => evaluateEligibility(f).map((r) => r.code);

describe("evaluateEligibility", () => {
  it("passes when everything is in order", () => expect(codes(base())).toEqual([]));

  it("flags the wrong truck type and insufficient capacity", () => {
    const f = base({ truck: { ...base().truck!, truckType: "6-wheeler", capacityKg: 5000 } });
    expect(codes(f)).toEqual(expect.arrayContaining(["truck_type", "truck_capacity"]));
  });

  it("treats an unspecified requirement or weight as no constraint", () => {
    const f = base({ trip: { ...base().trip, truckRequirement: null, weightKg: null }, truck: { ...base().truck!, truckType: "Flatbed", capacityKg: 1 } });
    expect(codes(f)).toEqual([]);
  });

  it("requires a license that is valid through the END of the job, not just its start", () => {
    expect(codes(base({ driver: { licenseNumber: "X", licenseExpiry: "2026-06-10" } }))).toEqual([]);
    expect(codes(base({ driver: { licenseNumber: "X", licenseExpiry: "2026-06-09" } }))).toEqual(["license_expired"]);
    expect(codes(base({ driver: { licenseNumber: null, licenseExpiry: null } }))).toEqual(["no_license"]);
  });

  it("checks registration and inspection against the job date; missing dates fail", () => {
    const t = base().truck!;
    expect(codes(base({ truck: { ...t, registrationExpiry: "2026-06-09" } }))).toEqual(["truck_registration"]);
    expect(codes(base({ truck: { ...t, inspectionExpiry: null } }))).toEqual(["truck_inspection"]);
  });

  it("uses today when the trip has no schedule", () => {
    const f = base({ trip: { ...base().trip, windowStart: null, windowEnd: null }, driver: { licenseNumber: "X", licenseExpiry: "2026-05-31" } });
    expect(codes(f)).toEqual(["license_expired"]);
  });

  it("rejects trucks that are in maintenance or retired, and reports conflicts", () => {
    expect(codes(base({ truck: { ...base().truck!, status: "maintenance" } }))).toEqual(["truck_status"]);
    expect(codes(base({ driverBusy: true, truckBusy: true }))).toEqual(["driver_busy", "truck_busy"]);
  });

  it("asks for a truck when none was chosen", () => {
    expect(codes(base({ truck: null }))).toEqual(["no_truck"]);
  });
});

describe("tripWindow", () => {
  it("spans first to last time, at least 8 hours", () => {
    const a = new Date("2026-06-10T01:00:00Z");
    expect(tripWindow([null, null])).toEqual({ start: null, end: null });
    expect(tripWindow([a, null]).end).toEqual(new Date("2026-06-10T09:00:00Z"));
    expect(tripWindow([new Date("2026-06-11T01:00:00Z"), a]).end).toEqual(new Date("2026-06-11T01:00:00Z"));
  });
});
