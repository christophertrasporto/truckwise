import { and, eq, sql } from "drizzle-orm";
import { withContext, withTenant } from "../db";
import { partnerApprovals, tenants, tripAssignments } from "../db/schema";
import { HttpError } from "../errors";
import type { TenantActor } from "./trips";

/**
 * The partner gateway. Subcontractor staff and drivers belong to THEIR company's tenant, but the trips
 * live in the HAULER's tenant. Every cross-company read or write goes through the helpers here, which
 * first prove the relationship (an approved partnership, or an active assignment) and only then let
 * callers open a transaction in the hauler's context. Nothing else should pass another company's id to
 * withTenant on a user's behalf.
 */

/** Haulers that have currently approved the actor's subcontractor company. */
export async function approvedHaulers(actor: TenantActor): Promise<{ id: string; name: string }[]> {
  return withTenant(actor.tenantId, actor.userId, (db) =>
    db
      .select({ id: partnerApprovals.tenantId, name: tenants.name })
      .from(partnerApprovals)
      .innerJoin(tenants, eq(tenants.id, partnerApprovals.tenantId))
      .where(and(eq(partnerApprovals.partnerTenantId, actor.tenantId), eq(partnerApprovals.status, "approved"))),
  );
}

export async function assertApprovedHauler(actor: TenantActor, haulerId: string): Promise<void> {
  const ok = (await approvedHaulers(actor)).some((h) => h.id === haulerId);
  if (!ok) throw new HttpError(404, "Trip not found");
}

/** Haulers where this company already has work assigned (kept even after an approval is revoked, so jobs can finish). */
export async function haulersWithMyAssignments(actor: TenantActor): Promise<{ id: string; name: string }[]> {
  const ids = await withContext({ tenantId: actor.tenantId, userId: actor.userId }, async (db) => {
    const res = await db.execute<{ id: string }>(sql`select my_partner_hauler_ids() as id`);
    return (res as unknown as { id: string }[]).map((r) => r.id);
  });
  if (ids.length === 0) return [];
  const rows = await Promise.all(
    ids.map((id) =>
      withTenant(actor.tenantId, actor.userId, (db) =>
        db.select({ id: tenants.id, name: tenants.name }).from(tenants).where(eq(tenants.id, id)),
      ),
    ),
  );
  return rows.flat();
}

/** Haulers that have given the calling DRIVER a live job. */
export async function driverHaulerIds(actor: TenantActor): Promise<string[]> {
  if (actor.role === "driver") return [actor.tenantId];
  return withContext({ tenantId: actor.tenantId, userId: actor.userId }, async (db) => {
    const res = await db.execute<{ id: string }>(sql`select my_driver_hauler_ids() as id`);
    return (res as unknown as { id: string }[]).map((r) => r.id);
  });
}

/** The hauler that owns the active assignment of this trip to this driver. 404 otherwise. */
export async function resolveDriverHauler(actor: TenantActor, tripId: string): Promise<string> {
  if (actor.role === "driver") return actor.tenantId;
  for (const hauler of await driverHaulerIds(actor)) {
    const [a] = await withTenant(hauler, actor.userId, (db) =>
      db
        .select({ id: tripAssignments.id })
        .from(tripAssignments)
        .where(
          and(
            eq(tripAssignments.tripId, tripId),
            eq(tripAssignments.driverUserId, actor.userId),
            eq(tripAssignments.status, "active"),
          ),
        ),
    );
    if (a) return hauler;
  }
  throw new HttpError(404, "Trip not found");
}

export const isWorkerDriver = (actor: TenantActor) => actor.role === "driver" || actor.role === "sub_driver";
