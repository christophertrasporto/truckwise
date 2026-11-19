import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { normalizePhPhone } from "@/shared/phone";
import { withContext, withTenant, withUser } from "../db";
import { notifications, pushSubscriptions, userNotificationSettings } from "../db/schema";
import { HttpError } from "../errors";
import type { Actor } from "../policy";
import { getPushSender, vapidPublicKey } from "./push";
import { getSmsProvider } from "./sms";

type TenantActor = Actor & { tenantId: string };
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** A person's own notifications for the company they are signed in to. Row-level security allows no one else's. */
export async function listNotifications(actor: TenantActor, opts: { limit?: number; unreadOnly?: boolean } = {}) {
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select()
      .from(notifications)
      .where(opts.unreadOnly ? isNull(notifications.readAt) : undefined)
      .orderBy(desc(notifications.createdAt))
      .limit(Math.min(opts.limit ?? 50, 200));
    return rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, createdAt: iso(n.createdAt), read: n.readAt !== null }));
  });
}

export async function unreadCount(actor: TenantActor): Promise<number> {
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(isNull(notifications.readAt));
    return r.n;
  });
}

export const markReadInput = z.union([z.object({ all: z.literal(true) }), z.object({ ids: z.array(z.string().uuid()).min(1).max(200) })]);

export async function markRead(actor: TenantActor, input: z.infer<typeof markReadInput>) {
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(isNull(notifications.readAt), "ids" in input ? inArray(notifications.id, input.ids) : undefined))
      .returning({ id: notifications.id });
    return { marked: rows.length };
  });
}

export const settingsInput = z.object({
  phone: z.string().trim().max(40).nullable(),
  smsEnabled: z.boolean(),
});

/** Channel status for the Account page: what is configured on the server and what this person chose. */
export async function getNotificationSettings(actor: Actor) {
  const [s, devices] = await withUser(actor.userId, async (db) => [
    (await db.select().from(userNotificationSettings).where(eq(userNotificationSettings.userId, actor.userId)))[0],
    (await db.select({ n: sql<number>`count(*)::int` }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, actor.userId)))[0].n,
  ] as const);
  return {
    phone: s?.phone ?? null,
    smsEnabled: s?.smsEnabled ?? false,
    devices,
    pushConfigured: getPushSender().configured(),
    vapidPublicKey: vapidPublicKey(),
    smsProviderIsReal: getSmsProvider().real,
  };
}

export async function saveNotificationSettings(actor: Actor, input: z.infer<typeof settingsInput>) {
  const phone = input.phone ? normalizePhPhone(input.phone) : null;
  if (input.phone && !phone) throw new HttpError(400, "Enter a Philippine mobile number, for example 0917 123 4567.");
  if (input.smsEnabled && !phone) throw new HttpError(400, "Add your mobile number to turn on text messages.");
  await withUser(actor.userId, (db) =>
    db
      .insert(userNotificationSettings)
      .values({ userId: actor.userId, phone, smsEnabled: input.smsEnabled })
      .onConflictDoUpdate({ target: userNotificationSettings.userId, set: { phone, smsEnabled: input.smsEnabled, updatedAt: new Date() } }),
  );
  return { phone, smsEnabled: input.smsEnabled };
}

export const subscriptionInput = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

/**
 * Remember a device for Web Push. A browser endpoint identifies a device; if another account used it before, it
 * moves to the current person. That ownership transfer is the one privileged write here, so it runs in a platform
 * context, and only after the route has authenticated the caller.
 */
export async function subscribePush(actor: Actor, input: z.infer<typeof subscriptionInput>, userAgent: string | null) {
  await withContext({ platform: true }, (db) =>
    db
      .insert(pushSubscriptions)
      .values({ userId: actor.userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: actor.userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null } }),
  );
}

export async function unsubscribePush(actor: Actor, endpoint: string) {
  await withUser(actor.userId, (db) => db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, actor.userId), eq(pushSubscriptions.endpoint, endpoint))));
}
