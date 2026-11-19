import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { epodSubmissions, tripStops, trips } from "../db/schema";
import { outstandingDocuments } from "./document-state";
import { moveTrip, type Ctx } from "./trips";

export interface StopProof {
  stopId: string;
  seq: number;
  address: string;
  /** needs_proof: nothing yet, or the last version was rejected / more was requested. */
  state: "needs_proof" | "pending" | "approved";
  latest: { id: string; version: number; status: "pending" | "approved" | "rejected" | "more_info_requested"; outcome: "complete" | "partial" | "discrepancy" | "failed" } | null;
}

/** Where every delivery stop stands, from the newest proof version of each stop. */
export async function stopProofs(db: Db, tripId: string): Promise<StopProof[]> {
  const stops = await db
    .select()
    .from(tripStops)
    .where(and(eq(tripStops.tripId, tripId), eq(tripStops.kind, "delivery")))
    .orderBy(asc(tripStops.seq));
  const subs = await db
    .select({ id: epodSubmissions.id, stopId: epodSubmissions.stopId, version: epodSubmissions.version, status: epodSubmissions.status, outcome: epodSubmissions.outcome })
    .from(epodSubmissions)
    .where(eq(epodSubmissions.tripId, tripId))
    .orderBy(desc(epodSubmissions.version));
  return stops.map((s) => {
    const latest = subs.find((x) => x.stopId === s.id) ?? null; // newest first
    const state: StopProof["state"] = !latest || latest.status === "rejected" || latest.status === "more_info_requested" ? "needs_proof" : latest.status === "approved" ? "approved" : "pending";
    return { stopId: s.id, seq: s.seq, address: s.address, state, latest };
  });
}

/**
 * Keeps the trip status in step with its proofs (runs inside the caller's transaction):
 *  - any delivery stop without usable proof          -> arrived_destination (the driver still owes proof)
 *  - every stop approved                             -> ready_for_invoice, once every required client document is approved
 *                                                       or waived (until then the trip stays at pod_submitted)
 *  - otherwise some proof awaits review              -> delivery_exception if any of it reports a problem, else pod_submitted
 * With one delivery stop this is exactly the single-proof workflow.
 */
export async function syncTripWithProof(db: Db, tripId: string, actor: { userId: string } | null, ctx: Ctx, note: string) {
  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!trip) return;
  const stops = await stopProofs(db, tripId);
  let target: "arrived_destination" | "ready_for_invoice" | "pod_submitted" | "delivery_exception";
  if (stops.length === 0 || stops.some((s) => s.state === "needs_proof")) target = "arrived_destination";
  else if (stops.every((s) => s.state === "approved")) target = (await outstandingDocuments(db, tripId)).length > 0 ? "pod_submitted" : "ready_for_invoice";
  else if (stops.some((s) => s.state === "pending" && s.latest!.outcome !== "complete")) target = "delivery_exception";
  else target = "pod_submitted";
  if (trip.status !== target) await moveTrip(db, trip, target, actor, ctx, note);
}
