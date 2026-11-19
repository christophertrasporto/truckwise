import { assertRoom } from "./entitlements";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { TRUCK_TYPES } from "@/shared/truck-types";
import { writeAudit } from "../audit";
import { withTenant } from "../db";
import { driverProfiles, memberships, trucks, users } from "../db/schema";
import { HttpError, isUniqueViolation } from "../errors";
import { authorize } from "../policy";
import type { TenantActor } from "./trips";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2027-03-31");

export const truckInput = z.object({
  plate: z.string().trim().min(2).max(20).transform((v) => v.toUpperCase()),
  truckType: z.enum(TRUCK_TYPES),
  capacityKg: z.number().int().min(100).max(100_000),
  registrationExpiry: isoDate.optional(),
  inspectionExpiry: isoDate.optional(),
});
export const truckPatch = z.object({
  status: z.enum(["active", "maintenance", "retired"]).optional(),
  capacityKg: z.number().int().min(100).max(100_000).optional(),
  registrationExpiry: isoDate.optional(),
  inspectionExpiry: isoDate.optional(),
});
export const driverProfileInput = z.object({
  licenseNumber: z.string().trim().min(3).max(40),
  licenseExpiry: isoDate,
  phone: z.string().trim().max(40).optional(),
});

export async function listTrucks(actor: TenantActor) {
  authorize(actor, "fleet:read");
  return withTenant(actor.tenantId, actor.userId, (db) => db.select().from(trucks).orderBy(asc(trucks.plate)));
}

export async function addTruck(actor: TenantActor, input: z.infer<typeof truckInput>, ctx: { requestId?: string } = {}) {
  authorize(actor, "fleet:manage");
  try {
    return await withTenant(actor.tenantId, actor.userId, async (db) => {
      await assertRoom(db, actor.tenantId, "trucks");
      const [t] = await db.insert(trucks).values({ ...input, tenantId: actor.tenantId }).returning();
      await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "truck.add", entityType: "truck", entityId: t.id, newValue: input, requestId: ctx.requestId });
      return { id: t.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "A truck with that plate already exists");
    throw err;
  }
}

export async function updateTruck(actor: TenantActor, id: string, patch: z.infer<typeof truckPatch>, ctx: { requestId?: string } = {}) {
  authorize(actor, "fleet:manage");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [before] = await db.select().from(trucks).where(eq(trucks.id, id));
    if (!before) throw new HttpError(404, "Truck not found");
    await db.update(trucks).set(patch).where(eq(trucks.id, id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "truck.update", entityType: "truck", entityId: id, oldValue: before, newValue: patch, requestId: ctx.requestId });
  });
}

/** Drivers of the actor's company with their license details. A driver sees only themself. */
export async function listDrivers(actor: TenantActor) {
  const own = actor.role === "driver" || actor.role === "sub_driver";
  if (!own) authorize(actor, "fleet:read");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select({
        userId: users.id,
        name: users.name,
        role: memberships.role,
        status: memberships.status,
        licenseNumber: driverProfiles.licenseNumber,
        licenseExpiry: driverProfiles.licenseExpiry,
        phone: driverProfiles.phone,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(driverProfiles, and(eq(driverProfiles.userId, memberships.userId), eq(driverProfiles.tenantId, memberships.tenantId)))
      .where(eq(memberships.tenantId, actor.tenantId))
      .orderBy(asc(users.name));
    return rows.filter((r) => (r.role === "driver" || r.role === "sub_driver") && (!own || r.userId === actor.userId));
  });
}

export async function upsertDriverProfile(actor: TenantActor, userId: string, input: z.infer<typeof driverProfileInput>, ctx: { requestId?: string } = {}) {
  authorize(actor, "fleet:manage");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [m] = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.tenantId, actor.tenantId), eq(memberships.userId, userId)));
    if (!m || (m.role !== "driver" && m.role !== "sub_driver")) throw new HttpError(404, "Driver not found");
    const [existing] = await db.select().from(driverProfiles).where(and(eq(driverProfiles.tenantId, actor.tenantId), eq(driverProfiles.userId, userId)));
    const values = { licenseNumber: input.licenseNumber, licenseExpiry: input.licenseExpiry, phone: input.phone ?? null, updatedAt: new Date() };
    if (existing) await db.update(driverProfiles).set(values).where(eq(driverProfiles.id, existing.id));
    else await db.insert(driverProfiles).values({ ...values, tenantId: actor.tenantId, userId });
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "driver.profile", entityType: "driver_profile", entityId: userId, oldValue: existing ? { licenseExpiry: existing.licenseExpiry } : null, newValue: { licenseExpiry: input.licenseExpiry }, requestId: ctx.requestId });
  });
}
