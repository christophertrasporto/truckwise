import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "@/server/audit";
import { closeDb, withContext, withTenant, withUser } from "@/server/db";
import { adminClient } from "@/server/db/admin";
import { auditLog, customers, memberships, partnerApprovals, tenants, users } from "@/server/db/schema";

const admin = adminClient();
let acme: string, bayan: string, santos: string;
let acmeOwner: string, bayanOwner: string;

beforeAll(async () => {
  const t = await admin.db.select().from(tenants);
  acme = t.find((x) => x.name === "Acme Haulers")!.id;
  bayan = t.find((x) => x.name === "Bayan Logistics")!.id;
  santos = t.find((x) => x.kind === "subcontractor")!.id;
  const u = await admin.db.select().from(users);
  acmeOwner = u.find((x) => x.email === "owner@acme.test")!.id;
  bayanOwner = u.find((x) => x.email === "owner@bayan.test")!.id;
});

afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

describe("tenant isolation (row-level security)", () => {
  it("returns nothing when no tenant context is set", async () => {
    const rows = await withContext({}, (db) => db.select().from(customers));
    expect(rows).toEqual([]);
  });

  it("each tenant sees only its own customers", async () => {
    const a = await withTenant(acme, acmeOwner, (db) => db.select().from(customers));
    const b = await withTenant(bayan, bayanOwner, (db) => db.select().from(customers));
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.every((c) => c.tenantId === acme)).toBe(true);
    expect(b.every((c) => c.tenantId === bayan)).toBe(true);
  });

  it("a cross-tenant filter by id still returns nothing", async () => {
    const [victim] = await withTenant(bayan, bayanOwner, (db) => db.select().from(customers).limit(1));
    const leaked = await withTenant(acme, acmeOwner, (db) =>
      db.select().from(customers).where(eq(customers.id, victim.id)),
    );
    expect(leaked).toEqual([]);
  });

  it("rejects inserting a row into another tenant", async () => {
    await expect(
      withTenant(acme, acmeOwner, (db) => db.insert(customers).values({ tenantId: bayan, name: "Planted" })),
    ).rejects.toThrow();
  });

  it("cannot update or delete another tenant's rows (0 rows affected, data intact)", async () => {
    const [victim] = await withTenant(bayan, bayanOwner, (db) => db.select().from(customers).limit(1));
    const upd = await withTenant(acme, acmeOwner, (db) =>
      db.update(customers).set({ name: "Hacked" }).where(eq(customers.id, victim.id)).returning(),
    );
    const del = await withTenant(acme, acmeOwner, (db) =>
      db.delete(customers).where(eq(customers.id, victim.id)).returning(),
    );
    expect(upd).toEqual([]);
    expect(del).toEqual([]);
    const [after] = await admin.db.select().from(customers).where(eq(customers.id, victim.id));
    expect(after.name).toBe(victim.name);
  });

  it("rejects moving a row to another tenant via update", async () => {
    const [mine] = await withTenant(acme, acmeOwner, (db) => db.select().from(customers).limit(1));
    await expect(
      withTenant(acme, acmeOwner, (db) => db.update(customers).set({ tenantId: bayan }).where(eq(customers.id, mine.id))),
    ).rejects.toThrow();
  });

  it("context does not leak between transactions on pooled connections", async () => {
    await withTenant(acme, acmeOwner, (db) => db.select().from(customers));
    const after = await withContext({}, (db) => db.select().from(customers));
    expect(after).toEqual([]);
  });

  it("users see only their own memberships without a tenant, and no other tenants' with one", async () => {
    const mine = await withUser(acmeOwner, (db) => db.select().from(memberships));
    expect(mine.map((m) => m.userId)).toEqual([acmeOwner]);
    const inTenant = await withTenant(bayan, bayanOwner, (db) => db.select().from(memberships));
    expect(inTenant.every((m) => m.tenantId === bayan)).toBe(true);
  });

  it("hides other companies in the tenants table", async () => {
    const seen = await withTenant(bayan, bayanOwner, (db) => db.select().from(tenants));
    expect(seen.map((t) => t.id)).toEqual([bayan]);
  });

  it("partner approvals are visible to the hauler and the partner, not to unrelated tenants", async () => {
    const hauler = await withTenant(acme, acmeOwner, (db) => db.select().from(partnerApprovals));
    const partner = await withTenant(santos, null, (db) => db.select().from(partnerApprovals));
    const other = await withTenant(bayan, bayanOwner, (db) => db.select().from(partnerApprovals));
    expect(hauler.length).toBeGreaterThanOrEqual(1);
    expect(hauler.every((a) => a.tenantId === acme)).toBe(true);
    expect(partner).toHaveLength(1);
    expect(partner[0].partnerTenantId).toBe(santos);
    expect(other).toEqual([]);
  });

  it("the partner cannot approve itself", async () => {
    const res = await withTenant(santos, null, (db) =>
      db
        .update(partnerApprovals)
        .set({ status: "approved" })
        .where(and(eq(partnerApprovals.partnerTenantId, santos)))
        .returning(),
    );
    expect(res).toEqual([]);
    await expect(
      withTenant(santos, null, (db) => db.insert(partnerApprovals).values({ tenantId: bayan, partnerTenantId: santos })),
    ).rejects.toThrow();
  });

  it("only platform context can create tenants", async () => {
    await expect(
      withTenant(acme, acmeOwner, (db) => db.insert(tenants).values({ name: "Rogue Co" })),
    ).rejects.toThrow();
    const [t] = await withContext({ platform: true }, (db) => db.insert(tenants).values({ name: "Platform Made Co" }).returning());
    expect(t.name).toBe("Platform Made Co");
  });
});

describe("audit log", () => {
  it("records inside the tenant and is invisible to other tenants", async () => {
    await withTenant(acme, acmeOwner, (db) =>
      writeAudit(db, { tenantId: acme, actorUserId: acmeOwner, action: "test.event", entityType: "test", entityId: "1" }),
    );
    const own = await withTenant(acme, acmeOwner, (db) => db.select().from(auditLog));
    const foreign = await withTenant(bayan, bayanOwner, (db) => db.select().from(auditLog));
    expect(own.some((r) => r.action === "test.event")).toBe(true);
    expect(foreign.some((r) => r.action === "test.event")).toBe(false);
  });

  it("cannot write an audit row for another tenant", async () => {
    await expect(
      withTenant(acme, acmeOwner, (db) =>
        writeAudit(db, { tenantId: bayan, actorUserId: acmeOwner, action: "forged", entityType: "test" }),
      ),
    ).rejects.toThrow();
  });

  it("is append-only for the app role", async () => {
    await expect(withTenant(acme, acmeOwner, (db) => db.update(auditLog).set({ action: "edited" }))).rejects.toThrow();
    await expect(withTenant(acme, acmeOwner, (db) => db.delete(auditLog))).rejects.toThrow();
  });

  it("is append-only even for the owner (trigger)", async () => {
    await expect(admin.db.update(auditLog).set({ action: "edited" })).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } });
    await expect(admin.db.delete(auditLog)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } });
  });
});

describe("schema guard", () => {
  it("every table with a tenant column has forced RLS and at least one policy", async () => {
    const rows = await admin.sql<{ table_name: string; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname as table_name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r'
        and exists (select 1 from information_schema.columns col
                    where col.table_schema = 'public' and col.table_name = c.relname
                      and col.column_name in ('tenant_id', 'partner_tenant_id'))`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r, r.table_name).toMatchObject({ rls: true, forced: true });
      expect(r.policies, r.table_name).toBeGreaterThan(0);
    }
  });

  it("the application role is not a superuser and cannot bypass RLS", async () => {
    const [r] = await admin.sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'smartload_app'`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
