import { eq } from "drizzle-orm";
import { adminClient } from "./admin";
import { companySettings, customers, driverProfiles, memberships, partnerApprovals, tenants, trucks, users } from "./schema";
import { hashPassword } from "../auth/sessions";

/** Demo logins (all share DEMO_PASSWORD). Local development only. */
export const DEMO_PASSWORD = "smartload-demo-1";

/** Demo data for automated tests and local experiments only. */
export async function seed(url = process.env.DATABASE_ADMIN_URL) {
  const { sql, db } = adminClient(url);
  try {
    const hash = await hashPassword(DEMO_PASSWORD);

    const [acme, bayan] = await db
      .insert(tenants)
      .values([
        { name: "Acme Haulers", kind: "hauler" },
        { name: "Bayan Logistics", kind: "hauler" },
      ])
      .returning();
    const [partner] = await db.insert(tenants).values({ name: "Santos Trucking (Subcontractor)", kind: "subcontractor" }).returning();

    const mk = (email: string, name: string, isPlatformAdmin = false) =>
      ({ email, name, passwordHash: hash, isPlatformAdmin }) as const;
    const created = await db
      .insert(users)
      .values([
        mk("admin@smartload.test", "Platform Admin", true),
        mk("owner@acme.test", "Acme Owner"),
        mk("dispatcher@acme.test", "Acme Dispatcher"),
        mk("accountant@acme.test", "Acme Accountant"),
        mk("driver@acme.test", "Acme Driver"),
        mk("owner@bayan.test", "Bayan Owner"),
        mk("owner@santos.test", "Santos Owner"),
        mk("driver@santos.test", "Santos Driver"),
      ])
      .returning();
    const u = Object.fromEntries(created.map((x) => [x.email, x.id]));

    await db.insert(memberships).values([
      { tenantId: acme.id, userId: u["owner@acme.test"], role: "owner" },
      { tenantId: acme.id, userId: u["dispatcher@acme.test"], role: "dispatcher" },
      { tenantId: acme.id, userId: u["accountant@acme.test"], role: "accountant" },
      { tenantId: acme.id, userId: u["driver@acme.test"], role: "driver" },
      { tenantId: bayan.id, userId: u["owner@bayan.test"], role: "owner" },
      { tenantId: partner.id, userId: u["owner@santos.test"], role: "sub_owner" },
      { tenantId: partner.id, userId: u["driver@santos.test"], role: "sub_driver" },
    ]);
    // Acme accepts immediately so tests can exercise both modes explicitly; real companies default to approval_required.
    await db.insert(companySettings).values([{ tenantId: acme.id, claimMode: "immediate" }, { tenantId: bayan.id }, { tenantId: partner.id }]);
    await db.insert(partnerApprovals).values({
      tenantId: acme.id,
      partnerTenantId: partner.id,
      status: "approved",
      approvedBy: u["owner@acme.test"],
    });
    await db.insert(customers).values([
      { tenantId: acme.id, name: "Mega Mart Distribution", address: "Taguig City" },
      { tenantId: acme.id, name: "Pacific Foods Inc.", address: "Calamba, Laguna" },
      { tenantId: bayan.id, name: "Visayas Steel Corp.", address: "Cebu City" },
    ]);
    await db.insert(trucks).values([
      { tenantId: acme.id, plate: "ACM-101", truckType: "10-wheeler", capacityKg: 12000, registrationExpiry: "2099-12-31", inspectionExpiry: "2099-12-31" },
      { tenantId: acme.id, plate: "ACM-102", truckType: "Closed van", capacityKg: 3000, registrationExpiry: "2099-12-31", inspectionExpiry: "2099-12-31" },
      { tenantId: partner.id, plate: "STS-201", truckType: "10-wheeler", capacityKg: 15000, registrationExpiry: "2099-12-31", inspectionExpiry: "2099-12-31" },
      { tenantId: partner.id, plate: "STS-202", truckType: "6-wheeler", capacityKg: 6000, registrationExpiry: "2099-12-31", inspectionExpiry: "2099-12-31" },
    ]);
    await db.insert(driverProfiles).values([
      { tenantId: acme.id, userId: u["driver@acme.test"], licenseNumber: "N01-11-111111", licenseExpiry: "2099-12-31" },
      { tenantId: partner.id, userId: u["driver@santos.test"], licenseNumber: "N02-22-222222", licenseExpiry: "2099-12-31" },
    ]);
    return { acme, bayan, partner, users: u };
  } finally {
    await sql.end();
  }
}


export interface OwnerInput {
  companyName: string;
  email: string;
  name: string;
  password: string;
}

/** Real internal setup: one company and its owner. Idempotent: does nothing if the owner email already exists. */
export async function seedOwner(input: OwnerInput, url = process.env.DATABASE_ADMIN_URL) {
  const { sql, db } = adminClient(url);
  try {
    const email = input.email.trim().toLowerCase();
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) return { created: false as const };
    const hash = await hashPassword(input.password);
    await db.transaction(async (tx) => {
      const [tenant] = await tx.insert(tenants).values({ name: input.companyName, kind: "hauler" }).returning();
      const [user] = await tx.insert(users).values({ email, name: input.name, passwordHash: hash }).returning();
      await tx.insert(memberships).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
      await tx.insert(companySettings).values({ tenantId: tenant.id });
    });
    return { created: true as const };
  } finally {
    await sql.end();
  }
}
