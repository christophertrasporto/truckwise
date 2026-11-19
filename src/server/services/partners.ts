import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import { hashPassword } from "../auth/sessions";
import { withContext, withTenant, type Db } from "../db";
import { companySettings, memberships, partnerApprovals, tenants, users } from "../db/schema";
import { HttpError } from "../errors";
import { authorize } from "../policy";
import type { TenantActor } from "./trips";

export const subcontractorInput = z.object({
  companyName: z.string().trim().min(2).max(200),
  ownerName: z.string().trim().min(1).max(200),
  ownerEmail: z.string().trim().toLowerCase().email(),
  password: z.string().min(10).max(200),
});

export async function listPartners(actor: TenantActor) {
  authorize(actor, "partner:read");
  return withTenant(actor.tenantId, actor.userId, (db) =>
    db
      .select({ partnerTenantId: partnerApprovals.partnerTenantId, name: tenants.name, status: partnerApprovals.status, since: partnerApprovals.createdAt })
      .from(partnerApprovals)
      .innerJoin(tenants, eq(tenants.id, partnerApprovals.partnerTenantId))
      .where(eq(partnerApprovals.tenantId, actor.tenantId))
      .orderBy(asc(tenants.name)),
  );
}

/**
 * Creates a subcontractor company with its owner login and approves it as this company's partner, inside the
 * caller's (platform-context) transaction. Returns whether the owner's login already existed (then the given
 * password was NOT applied to it).
 */
export async function createSubcontractorCompany(
  db: Db,
  hauler: { tenantId: string; actorUserId: string },
  input: z.infer<typeof subcontractorInput>,
  requestId?: string,
) {
  const [t] = await db.insert(tenants).values({ name: input.companyName, kind: "subcontractor" }).returning();
  let [owner] = await db.select().from(users).where(eq(users.email, input.ownerEmail));
  const existingAccount = !!owner;
  if (!owner) {
    [owner] = await db.insert(users).values({ email: input.ownerEmail, name: input.ownerName, passwordHash: await hashPassword(input.password) }).returning();
  }
  await db.insert(memberships).values({ tenantId: t.id, userId: owner.id, role: "sub_owner" });
  await db.insert(companySettings).values({ tenantId: t.id });
  await db.insert(partnerApprovals).values({ tenantId: hauler.tenantId, partnerTenantId: t.id, status: "approved", approvedBy: hauler.actorUserId });
  await writeAudit(db, { tenantId: hauler.tenantId, actorUserId: hauler.actorUserId, action: "partner.invite", entityType: "tenant", entityId: t.id, newValue: { companyName: input.companyName, ownerEmail: input.ownerEmail }, requestId });
  return { partnerTenantId: t.id, ownerUserId: owner.id, existingAccount };
}

/**
 * Creates a subcontractor company by hand. Creating a company is a platform-level write, so it runs in a platform
 * context: allowed only here, only after the caller is authorized as a hauler owner/ops manager.
 */
export async function inviteSubcontractor(actor: TenantActor, input: z.infer<typeof subcontractorInput>, ctx: { requestId?: string } = {}) {
  authorize(actor, "partner:manage");
  if (actor.tenantKind !== "hauler") throw new HttpError(403, "Only a trucking company can add subcontractors");
  return withContext({ platform: true, userId: actor.userId }, async (db) => {
    const r = await createSubcontractorCompany(db, { tenantId: actor.tenantId, actorUserId: actor.userId }, input, ctx.requestId);
    return { partnerTenantId: r.partnerTenantId };
  });
}

/** Approve or revoke a subcontractor. Revoking stops new offers; trips already assigned can still be completed. */
export async function setPartnerStatus(actor: TenantActor, partnerTenantId: string, status: "approved" | "revoked", ctx: { requestId?: string } = {}) {
  authorize(actor, "partner:manage");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .update(partnerApprovals)
      .set({ status, approvedBy: status === "approved" ? actor.userId : undefined, updatedAt: new Date() })
      .where(and(eq(partnerApprovals.tenantId, actor.tenantId), eq(partnerApprovals.partnerTenantId, partnerTenantId)))
      .returning({ id: partnerApprovals.id });
    if (rows.length === 0) throw new HttpError(404, "Subcontractor not found");
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: `partner.${status}`, entityType: "tenant", entityId: partnerTenantId, requestId: ctx.requestId });
  });
}
