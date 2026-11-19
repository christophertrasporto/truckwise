/**
 * Pure eligibility rules for putting a driver and truck on a trip. No database access, so it is
 * unit-testable; callers gather the facts (see src/server/services/eligibility.ts).
 */

export interface TripNeeds {
  truckRequirement: string | null;
  weightKg: number | null;
  /** When the job starts and ends, from the stops' required arrival times. Null if no times were set. */
  windowStart: Date | null;
  windowEnd: Date | null;
}

export interface TruckFacts {
  truckType: string;
  capacityKg: number;
  status: "active" | "maintenance" | "retired";
  /** ISO dates (YYYY-MM-DD) or null when never recorded. */
  registrationExpiry: string | null;
  inspectionExpiry: string | null;
}

export interface DriverFacts {
  licenseNumber: string | null;
  licenseExpiry: string | null;
}

export interface Reason {
  code:
    | "no_truck"
    | "truck_status"
    | "truck_type"
    | "truck_capacity"
    | "truck_registration"
    | "truck_inspection"
    | "truck_busy"
    | "no_license"
    | "license_expired"
    | "driver_busy";
  message: string;
}

export interface EligibilityFacts {
  trip: TripNeeds;
  truck: TruckFacts | null;
  driver: DriverFacts;
  driverBusy: boolean;
  truckBusy: boolean;
  now: Date;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Documents must be valid through the END of the job (or today when no schedule is set). */
export function referenceDay(trip: TripNeeds, now: Date): string {
  return day(trip.windowEnd ?? trip.windowStart ?? now);
}

/** Same rule as the SQL trip_window(): first to last required time, at least 8 hours long. */
export function tripWindow(times: (Date | null)[]): { start: Date | null; end: Date | null } {
  const set = times.filter((t): t is Date => !!t).sort((a, b) => a.getTime() - b.getTime());
  if (set.length === 0) return { start: null, end: null };
  const start = set[0];
  const end = new Date(Math.max(set[set.length - 1].getTime(), start.getTime() + 8 * 3600_000));
  return { start, end };
}

export function evaluateEligibility(f: EligibilityFacts): Reason[] {
  const out: Reason[] = [];
  const ref = referenceDay(f.trip, f.now);

  if (!f.driver.licenseNumber || !f.driver.licenseExpiry) {
    out.push({ code: "no_license", message: "The driver has no license on file." });
  } else if (f.driver.licenseExpiry < ref) {
    out.push({ code: "license_expired", message: `The driver's license expires ${f.driver.licenseExpiry}, before this job ends.` });
  }
  if (f.driverBusy) out.push({ code: "driver_busy", message: "The driver is already on another trip at that time." });

  if (!f.truck) {
    out.push({ code: "no_truck", message: "Choose a truck." });
    return out;
  }
  const t = f.truck;
  if (t.status !== "active") out.push({ code: "truck_status", message: `The truck is ${t.status}.` });
  const need = f.trip.truckRequirement?.trim();
  if (need && t.truckType.toLowerCase() !== need.toLowerCase()) {
    out.push({ code: "truck_type", message: `This trip needs a ${need}; the truck is a ${t.truckType}.` });
  }
  if (f.trip.weightKg != null && t.capacityKg < f.trip.weightKg) {
    out.push({ code: "truck_capacity", message: `The load is ${f.trip.weightKg} kg; the truck carries ${t.capacityKg} kg.` });
  }
  if (!t.registrationExpiry || t.registrationExpiry < ref) {
    out.push({ code: "truck_registration", message: t.registrationExpiry ? `The truck registration expires ${t.registrationExpiry}.` : "No registration expiry is recorded for the truck." });
  }
  if (!t.inspectionExpiry || t.inspectionExpiry < ref) {
    out.push({ code: "truck_inspection", message: t.inspectionExpiry ? `The truck inspection expires ${t.inspectionExpiry}.` : "No inspection expiry is recorded for the truck." });
  }
  if (f.truckBusy) out.push({ code: "truck_busy", message: "The truck is already on another trip at that time." });
  return out;
}
