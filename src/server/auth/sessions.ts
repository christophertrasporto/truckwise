import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, gt } from "drizzle-orm";
import { withContext, withUser } from "../db";
import { memberships, sessions, tenants, users } from "../db/schema";
import type { Actor } from "../policy";

export const SESSION_COOKIE = "sl_session";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

let dummyHash: string | undefined;

export const normalizeEmail= (email: string) => email.trim().toLowerCase();

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/** Returns the user id on success. Runs the hash compare even for unknown emails to blunt timing probes. */
export async function verifyCredentials(email: string, password: string): Promise<string | null> {
  const [row] = await withContext({}, (db) =>
    db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1),
  );
  const ok = await bcrypt.compare(password, row?.passwordHash ?? (dummyHash ??= bcrypt.hashSync("dummy", 12)));
  return row && ok ? row.id : null;
}

export async function createSession(userId: string, ttlDays: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await withUser(userId, async (db) => {
    const active = await db
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")))
      .limit(1);
    await db.insert(sessions).values({
      id: hashToken(token),
      userId,
      activeTenantId: active[0]?.tenantId ?? null,
      expiresAt,
    });
  });
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await withContext({}, (db) => db.delete(sessions).where(eq(sessions.id, hashToken(token))));
}

/**
 * Resolve a cookie token to an Actor, re-checking on every request that the membership
 * and tenant are still active. Returns null for missing/expired/revoked sessions.
 */
export async function resolveActor(token: string | undefined | null): Promise<Actor | null> {
  if (!token) return null;
  const [s] = await withContext({}, (db) =>
    db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
      .limit(1),
  );
  if (!s) return null;

  return withUser(s.userId, async (db) => {
    const [u] = await db.select().from(users).where(eq(users.id, s.userId)).limit(1);
    if (!u) return null;
    const base = { userId: u.id, isPlatformAdmin: u.isPlatformAdmin };
    if (!s.activeTenantId) return { ...base, tenantId: null, tenantKind: null, role: null };

    const [m] = await db
      .select({ role: memberships.role, status: memberships.status, kind: tenants.kind, tStatus: tenants.status })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, u.id), eq(memberships.tenantId, s.activeTenantId)))
      .limit(1);
    if (!m || m.status !== "active" || m.tStatus !== "active") {
      return { ...base, tenantId: null, tenantKind: null, role: null };
    }
    return { ...base, tenantId: s.activeTenantId, tenantKind: m.kind, role: m.role };
  });
}

/** Switch the session's active tenant, only to a tenant the user has an active membership in. */
export async function switchTenant(token: string, userId: string, tenantId: string): Promise<boolean> {
  return withUser(userId, async (db) => {
    const [m] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId), eq(memberships.status, "active")))
      .limit(1);
    if (!m) return false;
    await db.update(sessions).set({ activeTenantId: tenantId }).where(eq(sessions.id, hashToken(token)));
    return true;
  });
}
