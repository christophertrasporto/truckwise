import { and, eq } from "drizzle-orm";
import { adminClient } from "@/server/db/admin";
import { customers, driverProfiles, memberships, tenants, trucks, users } from "@/server/db/schema";
import { hashPassword } from "@/server/auth/sessions";
import "@/server/jobs/handlers";
import { drainJobs } from "@/server/jobs/queue";
import type { TenantActor } from "@/server/services/trips";
import type { CreateTripInput } from "@/shared/schemas/trip";

export const admin = adminClient();

/** 1x1 PNG: real magic bytes, so the server's content sniffing accepts it. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export async function actorFor(email: string): Promise<TenantActor> {
  const [row] = await admin.db
    .select({ userId: users.id, tenantId: memberships.tenantId, role: memberships.role, kind: tenants.kind, admin: users.isPlatformAdmin })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(users.email, email));
  return { userId: row.userId, tenantId: row.tenantId, tenantKind: row.kind, role: row.role, isPlatformAdmin: row.admin };
}

let n = 0;
export async function extraDriver(tenantId: string): Promise<TenantActor> {
  const email = `extra-driver-${Date.now()}-${n++}@acme.test`;
  const [u] = await admin.db.insert(users).values({ email, name: `Extra ${n}`, passwordHash: await hashPassword("x".repeat(12)) }).returning();
  await admin.db.insert(memberships).values({ tenantId, userId: u.id, role: "driver" });
  await admin.db.insert(driverProfiles).values({ tenantId, userId: u.id, licenseNumber: "N99-00-000000", licenseExpiry: "2099-12-31" });
  return actorFor(email);
}

export async function customerOf(tenantId: string) {
  const [c] = await admin.db.select().from(customers).where(eq(customers.tenantId, tenantId)).limit(1);
  return c;
}

export const tripInput = (customerId: string, over: Partial<CreateTripInput> = {}): CreateTripInput => ({
  customerId,
  reference: `TR-${Date.now()}-${n++}`,
  cargoDescription: "20 pallets of canned goods",
  contractRateCentavos: 1_850_000,
  payoutCentavos: 1_400_000,
  fuelIncluded: true,
  tollIncluded: false,
  stops: [
    { kind: "pickup", address: "Calamba, Laguna" },
    { kind: "delivery", address: "Taguig City" },
  ],
  ...over,
});

export { and, eq };

export async function truckIdOf(tenantId: string, plate?: string) {
  const rows = await admin.db.select().from(trucks).where(eq(trucks.tenantId, tenantId));
  return (plate ? rows.find((r) => r.plate === plate) : rows[0])!.id;
}

/** Runs every due background job (scan, display copy, auto-approval) to completion. */
export async function drain() {
  // Notifications fan out into many jobs, so keep going until nothing is due.
  for (let i = 0; i < 20; i++) {
    const r = await drainJobs({ limit: 500, backoffBaseMs: 1 });
    if (r.ok + r.failed === 0) break;
  }
}
