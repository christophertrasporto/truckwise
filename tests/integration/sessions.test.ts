import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  createSession,
  destroySession,
  resolveActor,
  switchTenant,
  verifyCredentials,
} from "@/server/auth/sessions";
import { closeDb } from "@/server/db";
import { adminClient } from "@/server/db/admin";
import { DEMO_PASSWORD } from "@/server/db/seed";
import { memberships, sessions, tenants, users } from "@/server/db/schema";

const admin = adminClient();
afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

describe("sessions", () => {
  it("rejects wrong passwords and unknown emails, accepts correct ones (case-insensitive email)", async () => {
    expect(await verifyCredentials("owner@acme.test", "nope")).toBeNull();
    expect(await verifyCredentials("ghost@nowhere.test", DEMO_PASSWORD)).toBeNull();
    expect(await verifyCredentials("  OWNER@Acme.test ", DEMO_PASSWORD)).not.toBeNull();
  });

  it("resolves a session to the actor's tenant and role, and stores only a hash of the token", async () => {
    const id = (await verifyCredentials("dispatcher@acme.test", DEMO_PASSWORD))!;
    const { token } = await createSession(id, 1);
    const actor = await resolveActor(token);
    expect(actor).toMatchObject({ userId: id, role: "dispatcher", tenantKind: "hauler", isPlatformAdmin: false });
    const stored = await admin.db.select().from(sessions).where(eq(sessions.userId, id));
    expect(stored.some((s) => s.id === token)).toBe(false);
  });

  it("returns null for unknown, destroyed and expired sessions", async () => {
    expect(await resolveActor("garbage")).toBeNull();
    expect(await resolveActor(undefined)).toBeNull();
    const id = (await verifyCredentials("driver@acme.test", DEMO_PASSWORD))!;
    const { token } = await createSession(id, 1);
    await destroySession(token);
    expect(await resolveActor(token)).toBeNull();
    const expired = await createSession(id, -1);
    expect(await resolveActor(expired.token)).toBeNull();
  });

  it("drops tenant access immediately when the membership is disabled", async () => {
    const id = (await verifyCredentials("accountant@acme.test", DEMO_PASSWORD))!;
    const { token } = await createSession(id, 1);
    expect((await resolveActor(token))?.role).toBe("accountant");
    await admin.db.update(memberships).set({ status: "disabled" }).where(eq(memberships.userId, id));
    expect(await resolveActor(token)).toMatchObject({ tenantId: null, role: null });
    await admin.db.update(memberships).set({ status: "active" }).where(eq(memberships.userId, id));
  });

  it("drops tenant access when the company is suspended", async () => {
    const id = (await verifyCredentials("owner@bayan.test", DEMO_PASSWORD))!;
    const { token } = await createSession(id, 1);
    const [t] = await admin.db.select().from(tenants).where(eq(tenants.name, "Bayan Logistics"));
    await admin.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, t.id));
    expect(await resolveActor(token)).toMatchObject({ tenantId: null, role: null });
    await admin.db.update(tenants).set({ status: "active" }).where(eq(tenants.id, t.id));
  });

  it("only allows switching to a company the user belongs to", async () => {
    const id = (await verifyCredentials("owner@acme.test", DEMO_PASSWORD))!;
    const { token } = await createSession(id, 1);
    const [bayan] = await admin.db.select().from(tenants).where(eq(tenants.name, "Bayan Logistics"));
    expect(await switchTenant(token, id, bayan.id)).toBe(false);
    expect((await resolveActor(token))?.tenantId).not.toBe(bayan.id);
  });

  it("flags platform admins", async () => {
    const [u] = await admin.db.select().from(users).where(eq(users.email, "admin@smartload.test"));
    const { token } = await createSession(u.id, 1);
    expect(await resolveActor(token)).toMatchObject({ isPlatformAdmin: true, tenantId: null });
  });
});
