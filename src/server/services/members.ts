import { assertRoom } from "./entitlements";
import bcrypt from "bcryptjs";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { changePasswordInput, memberInput } from "@/shared/schemas/trip";
import { writeAudit } from "../audit";
import { hashPassword } from "../auth/sessions";
import { withContext, withTenant } from "../db";
import { memberships, sessions, users } from "../db/schema";
import { HttpError } from "../errors";
import { authorize } from "../policy";
import type { TenantActor } from "./trips";

export async function listMembers(actor: TenantActor) {
  authorize(actor, "member:read");
  return withTenant(actor.tenantId, actor.userId, (db) =>
    db
      .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, status: memberships.status })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, actor.tenantId))
      .orderBy(asc(users.name)),
  );
}

/** Owner creates a team member with an initial password they must change. Existing emails are added to this company. */
export async function addMember(actor: TenantActor, input: z.infer<typeof memberInput>, ctx: { requestId?: string } = {}) {
  authorize(actor, "member:manage");
  const partnerRole = input.role === "sub_manager" || input.role === "sub_driver";
  if (partnerRole !== (actor.tenantKind === "subcontractor")) {
    throw new HttpError(400, partnerRole ? "Subcontractor roles are only for subcontractor companies" : "That role is only for trucking companies");
  }
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    let [user] = await db.select().from(users).where(eq(users.email, input.email));
    if (!user) {
      [user] = await db
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password) })
        .returning();
    }
    const [existing] = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.tenantId, actor.tenantId), eq(memberships.userId, user.id)));
    if (existing) throw new HttpError(409, "That person is already on the team");
    await assertRoom(db, actor.tenantId, "users");
    if (input.role === "driver" || input.role === "sub_driver") await assertRoom(db, actor.tenantId, "drivers");
    await db.insert(memberships).values({ tenantId: actor.tenantId, userId: user.id, role: input.role });
    await writeAudit(db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "member.add",
      entityType: "membership",
      entityId: user.id,
      newValue: { email: input.email, role: input.role },
      requestId: ctx.requestId,
    });
    return { userId: user.id };
  });
}

/** Changes the caller's own password and signs out all of their other sessions. */
export async function changePassword(
  userId: string,
  keepSessionId: string,
  input: z.infer<typeof changePasswordInput>,
) {
  return withContext({ userId }, async (db) => {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u || !(await bcrypt.compare(input.currentPassword, u.passwordHash))) {
      throw new HttpError(400, "Current password is incorrect");
    }
    await db.update(users).set({ passwordHash: await hashPassword(input.newPassword) }).where(eq(users.id, userId));
    const all = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
    for (const s of all) if (s.id !== keepSessionId) await db.delete(sessions).where(eq(sessions.id, s.id));
  });
}
