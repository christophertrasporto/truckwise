import { asc, inArray } from "drizzle-orm";
import type { BoardFilters } from "@/shared/schemas/trip";
import type { Db } from "../db";
import { tripStops } from "../db/schema";

export interface StopSummary {
  stops: { seq: number; kind: "pickup" | "delivery"; address: string; requiredArrivalAt: string | null }[];
  origin: string | null;
  destination: string | null;
  startsAt: string | null;
}

/** Stops for many trips in one query (the caller's context decides which trips are visible). */
export async function loadStopSummaries(db: Db, tripIds: string[]): Promise<Map<string, StopSummary>> {
  const out = new Map<string, StopSummary>();
  if (tripIds.length === 0) return out;
  const rows = await db.select().from(tripStops).where(inArray(tripStops.tripId, tripIds)).orderBy(asc(tripStops.tripId), asc(tripStops.seq));
  for (const r of rows) {
    const s = out.get(r.tripId) ?? { stops: [], origin: null, destination: null, startsAt: null };
    s.stops.push({ seq: r.seq, kind: r.kind, address: r.address, requiredArrivalAt: r.requiredArrivalAt?.toISOString() ?? null });
    out.set(r.tripId, s);
  }
  for (const s of out.values()) {
    s.origin = s.stops.find((x) => x.kind === "pickup")?.address ?? s.stops[0]?.address ?? null;
    s.destination = [...s.stops].reverse().find((x) => x.kind === "delivery")?.address ?? null;
    s.startsAt = s.stops.find((x) => x.requiredArrivalAt)?.requiredArrivalAt ?? null;
  }
  return out;
}

/** Board filters: location text (any stop), date range (first scheduled time), truck type, minimum payout. */
export function matchesFilters(
  t: { truckRequirement: string | null; payoutCentavos: number },
  s: StopSummary | undefined,
  f: BoardFilters,
): boolean {
  if (f.location) {
    const q = f.location.toLowerCase();
    if (!s?.stops.some((x) => x.address.toLowerCase().includes(q))) return false;
  }
  if (f.from || f.to) {
    if (!s?.startsAt) return false;
    // Compare calendar days in Asia/Manila (UTC+8, no DST), the company's display time zone.
    const day = new Date(Date.parse(s.startsAt) + 8 * 3600_000).toISOString().slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
  }
  if (f.truckType && t.truckRequirement && t.truckRequirement.toLowerCase() !== f.truckType.toLowerCase()) return false;
  if (f.minPayoutCentavos != null && t.payoutCentavos < f.minPayoutCentavos) return false;
  return true;
}
