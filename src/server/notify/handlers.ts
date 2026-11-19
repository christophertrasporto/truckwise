import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { withContext, type Db } from "../db";
import {
  memberships,
  notificationDeliveries,
  notifications,
  partnerApprovals,
  pushSubscriptions,
  settlements,
  subconApplications,
  tenants,
  tripApplications,
  tripAssignments,
  tripExpenses,
  tripOfferTargets,
  tripOffers,
  tripStops,
  trips,
  userNotificationSettings,
  users,
  epodSubmissions,
} from "../db/schema";
import { enqueue, registerJob } from "../jobs/queue";
import { logger } from "../logger";
import { eventKey, emitEvent, type NotifyEvent } from "./events";
import { isUrgent, msg, tripLink, type Draft, type TripFacts } from "./messages";
import { getPushSender } from "./push";
import { getSmsProvider } from "./sms";

type Role = string;
interface Person {
  userId: string;
  tenantId: string;
  role: Role;
}
interface Target extends Person {
  draft: Draft;
  link: string | null;
  entityType: string;
  entityId: string;
}

const DISPATCH = ["owner", "ops_manager", "dispatcher"];
const FINANCE = ["owner", "accountant"];
const EXCEPTION_OWNERS = ["owner", "ops_manager"];

async function peopleWithRoles(db: Db, tenantId: string, roles: Role[]): Promise<Person[]> {
  const rows = await db
    .select({ userId: memberships.userId, tenantId: memberships.tenantId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, "active"), inArray(memberships.role, roles as never[])));
  return rows;
}

async function member(db: Db, userId: string, tenantId: string): Promise<Person | null> {
  const [m] = await db
    .select({ userId: memberships.userId, tenantId: memberships.tenantId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId), eq(memberships.status, "active")));
  return m ?? null;
}

const partnerStaff = (db: Db, partnerTenantId: string) => peopleWithRoles(db, partnerTenantId, ["sub_owner", "sub_manager"]);

async function tripFacts(db: Db, tripId: string, hauler: string): Promise<TripFacts | null> {
  const [t] = await db.select({ id: trips.id, reference: trips.reference }).from(trips).where(eq(trips.id, tripId));
  if (!t) return null;
  const stops = await db.select().from(tripStops).where(eq(tripStops.tripId, tripId)).orderBy(asc(tripStops.seq));
  return {
    tripId,
    hauler,
    reference: t.reference,
    origin: stops.find((s) => s.kind === "pickup")?.address ?? stops[0]?.address ?? "?",
    destination: [...stops].reverse().find((s) => s.kind === "delivery")?.address ?? "?",
  };
}

const userName = async (db: Db, id: string) => (await db.select({ n: users.name }).from(users).where(eq(users.id, id)))[0]?.n ?? "Someone";

/** The company a trip's current worker belongs to, and their driver. Falls back to the most recent assignment. */
async function workerOf(db: Db, tripId: string) {
  const rows = await db.select().from(tripAssignments).where(eq(tripAssignments.tripId, tripId));
  const live = rows.find((a) => a.status === "active");
  return live ?? rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

/** Turns one event into the notifications each person should get. Pure reads; inserting is done by the caller. */
async function targetsFor(db: Db, e: NotifyEvent): Promise<Target[]> {
  const hauler = e.tenantId;
  const out: Target[] = [];
  const add = (p: Person, draft: Draft, t: TripFacts | null, entityType: string, entityId: string, link?: string | null) =>
    out.push({ ...p, draft, link: link !== undefined ? link : t ? tripLink(p.role, t) : null, entityType, entityId });
  const addAll = (ps: Person[], draft: Draft, t: TripFacts | null, entityType: string, entityId: string, link?: string | null) => ps.forEach((p) => add(p, draft, t, entityType, entityId, link));

  if (e.type === "subscription.expiring") {
    addAll(await peopleWithRoles(db, hauler, ["owner"]), msg.subscriptionExpiring(e.periodEnd), null, "subscription", e.subscriptionId, "/app/settings");
    return out;
  }

  if (e.type === "subcon.applied") {
    const [a] = await db.select().from(subconApplications).where(eq(subconApplications.id, e.applicationId));
    if (!a) return [];
    addAll(await peopleWithRoles(db, hauler, ["owner", "ops_manager"]), msg.subconApplied(a.companyName), null, "subcon_application", a.id, `/app/applications/${a.id}`);
    return out;
  }

  if (e.type === "settlement.changed") {
    const [s] = await db.select().from(settlements).where(eq(settlements.id, e.settlementId));
    if (!s) return [];
    const staff = await partnerStaff(db, s.partnerTenantId);
    const link = `/app/settlements/from/${hauler}/${s.id}`;
    addAll(staff, e.what === "issued" ? msg.settlementIssued(s.number) : msg.settlementPaid(s.number), null, "settlement", s.id, link);
    return out;
  }

  if (!("tripId" in e)) return [];
  const t = await tripFacts(db, e.tripId, hauler);
  if (!t) return [];

  switch (e.type) {
    case "offer.created": {
      const [o] = await db.select().from(tripOffers).where(eq(tripOffers.id, e.offerId));
      if (!o) return [];
      const toInternal = o.mode === "broadcast_internal" || o.mode === "broadcast_all" || (o.mode === "applicants" && (o.audience === "internal" || o.audience === "all"));
      const toPartners = o.mode === "broadcast_partners" || o.mode === "broadcast_all" || (o.mode === "applicants" && (o.audience === "partners" || o.audience === "all"));
      const draft = o.mode === "applicants" ? msg.offerOpenCall(t) : msg.offerNew(t);
      if (toInternal) addAll(await peopleWithRoles(db, hauler, ["driver"]), draft, t, "trip", t.tripId);
      if (toPartners) {
        const approved = await db
          .select({ id: partnerApprovals.partnerTenantId })
          .from(partnerApprovals)
          .where(and(eq(partnerApprovals.tenantId, hauler), eq(partnerApprovals.status, "approved")));
        for (const p of approved) addAll(await partnerStaff(db, p.id), draft, t, "trip", t.tripId);
      }
      if (o.mode === "selected") {
        const targets = await db.select().from(tripOfferTargets).where(eq(tripOfferTargets.offerId, o.id));
        for (const x of targets) {
          const p = await member(db, x.targetUserId, hauler);
          if (p) add(p, msg.offerNew(t), t, "trip", t.tripId);
        }
      }
      if (o.mode === "direct") {
        if (o.targetUserId) {
          const p = await member(db, o.targetUserId, hauler);
          if (p) add(p, msg.offerDirect(t), t, "trip", t.tripId);
        }
        if (o.targetTenantId) addAll(await partnerStaff(db, o.targetTenantId), msg.offerDirect(t), t, "trip", t.tripId);
      }
      return out;
    }
    case "offer.expired":
      addAll(await peopleWithRoles(db, hauler, DISPATCH), msg.offerExpired(t), t, "trip", t.tripId);
      return out;
    case "offer.declined": {
      const who = await userName(db, e.byUserId);
      addAll(await peopleWithRoles(db, hauler, DISPATCH), msg.offerDeclined(t, who), t, "trip", t.tripId);
      return out;
    }
    case "application.created": {
      const [a] = await db.select().from(tripApplications).where(eq(tripApplications.id, e.applicationId));
      if (!a) return [];
      const [co] = a.applicantTenantId === hauler ? [null] : await db.select({ n: tenants.name }).from(tenants).where(eq(tenants.id, a.applicantTenantId));
      const who = `${a.driverName ?? (await userName(db, a.applicantUserId))}${co ? ` (${co.n})` : ""}`;
      addAll(await peopleWithRoles(db, hauler, DISPATCH), msg.applicationNew(t, who), t, "trip", t.tripId);
      return out;
    }
    case "application.decided": {
      const [a] = await db.select().from(tripApplications).where(eq(tripApplications.id, e.applicationId));
      if (!a) return [];
      const p = await member(db, a.applicantUserId, a.applicantTenantId);
      if (p) add(p, e.decision === "approved" ? msg.applicationApproved(t) : msg.applicationDeclined(t, e.reason), t, "trip", t.tripId);
      return out;
    }
    case "trip.claimed": {
      const [a] = await db.select().from(tripAssignments).where(eq(tripAssignments.id, e.assignmentId));
      if (!a) return [];
      const external = a.assignedTenantId !== hauler;
      const who = `${a.driverName ?? "A driver"}${external ? ` (${(await db.select({ n: tenants.name }).from(tenants).where(eq(tenants.id, a.assignedTenantId)))[0]?.n ?? "subcontractor"})` : ""}`;
      if (e.via === "claim") addAll(await peopleWithRoles(db, hauler, DISPATCH), msg.tripClaimed(t, who), t, "trip", t.tripId);
      // the driver who was chosen by someone else (a subcontractor's driver, or one picked by dispatch)
      if (a.driverUserId !== e.actorUserId && a.driverUserId !== e.applicantUserId) {
        const p = await member(db, a.driverUserId, a.assignedTenantId);
        if (p) add(p, msg.tripAssigned(t), t, "trip", t.tripId);
      }
      // everyone else who was told about the open trip: it is gone
      const told = await db
        .select({ userId: notifications.userId, tenantId: notifications.tenantId })
        .from(notifications)
        .where(and(eq(notifications.kind, "offer.new"), eq(notifications.entityId, t.tripId)));
      const roles = told.length ? await db.select({ userId: memberships.userId, tenantId: memberships.tenantId, role: memberships.role }).from(memberships).where(inArray(memberships.userId, told.map((x) => x.userId))) : [];
      for (const x of told) {
        if (x.userId === e.actorUserId || x.userId === a.driverUserId) continue;
        const r = roles.find((m) => m.userId === x.userId && m.tenantId === x.tenantId);
        if (r) add({ userId: x.userId, tenantId: x.tenantId, role: r.role }, msg.offerClosed(t), t, "trip", t.tripId);
      }
      return out;
    }
    case "assignment.released": {
      const [a] = await db.select().from(tripAssignments).where(eq(tripAssignments.id, e.assignmentId));
      if (!a) return [];
      const driver = await member(db, a.driverUserId, a.assignedTenantId);
      if (driver) add(driver, msg.released(t, e.reason), t, "trip", t.tripId);
      if (a.assignedTenantId !== hauler) addAll(await partnerStaff(db, a.assignedTenantId), msg.released(t, e.reason), t, "trip", t.tripId);
      return out;
    }
    case "trip.cancelled": {
      const rows = await db.select().from(tripAssignments).where(eq(tripAssignments.tripId, t.tripId));
      for (const a of rows.filter((x) => x.releasedReason === "Trip cancelled")) {
        const driver = await member(db, a.driverUserId, a.assignedTenantId);
        if (driver) add(driver, msg.cancelled(t), t, "trip", t.tripId);
        if (a.assignedTenantId !== hauler) addAll(await partnerStaff(db, a.assignedTenantId), msg.cancelled(t), t, "trip", t.tripId);
      }
      return out;
    }
    case "trip.status": {
      const w = await workerOf(db, t.tripId);
      const who = w?.driverName ?? "The driver";
      if (e.to === "arrived_pickup") addAll(await peopleWithRoles(db, hauler, DISPATCH), msg.arrivedPickup(t, who), t, "trip", t.tripId);
      if (e.to === "arrived_destination") addAll(await peopleWithRoles(db, hauler, DISPATCH), msg.arrivedDestination(t, who), t, "trip", t.tripId);
      if (e.to === "ready_for_invoice") {
        addAll(await peopleWithRoles(db, hauler, ["ops_manager", "dispatcher"]), msg.completed(t), t, "trip", t.tripId);
        addAll(await peopleWithRoles(db, hauler, FINANCE), msg.invoiceReady(t), t, "trip", t.tripId, "/app/invoices");
      }
      return out;
    }
    case "pod.submitted": {
      const [s] = await db.select().from(epodSubmissions).where(eq(epodSubmissions.id, e.submissionId));
      if (!s) return [];
      const draft = s.outcome === "complete" ? msg.podSubmitted(t, s.version) : msg.podException(t, s.outcome);
      addAll(await peopleWithRoles(db, hauler, DISPATCH), draft, t, "trip", t.tripId);
      return out;
    }
    case "pod.exception_escalated":
      addAll(await peopleWithRoles(db, hauler, EXCEPTION_OWNERS), msg.podEscalated(t), t, "trip", t.tripId);
      return out;
    case "pod.reviewed": {
      const [s] = await db.select().from(epodSubmissions).where(eq(epodSubmissions.id, e.submissionId));
      if (!s) return [];
      const w = await workerOf(db, t.tripId);
      const workerTenant = w?.assignedTenantId ?? hauler;
      const draft = e.decision === "approve" ? msg.podApproved(t, e.automatic) : e.decision === "reject" ? msg.podRejected(t, e.reason) : msg.podMore(t, e.reason);
      const driver = await member(db, s.driverUserId, workerTenant);
      if (driver) add(driver, draft, t, "trip", t.tripId);
      if (workerTenant !== hauler) addAll(await partnerStaff(db, workerTenant), draft, t, "trip", t.tripId);
      return out;
    }
    case "expense.submitted": {
      const [x] = await db.select().from(tripExpenses).where(eq(tripExpenses.id, e.expenseId));
      if (!x) return [];
      const who = await userName(db, x.submittedBy);
      addAll(await peopleWithRoles(db, hauler, ["owner", "ops_manager", "accountant"]), msg.expenseSubmitted(t, who), t, "expense", x.id, "/app/expenses");
      return out;
    }
    case "expense.reviewed": {
      const [x] = await db.select().from(tripExpenses).where(eq(tripExpenses.id, e.expenseId));
      if (!x) return [];
      const p = await member(db, x.submittedBy, hauler);
      if (p) add(p, e.decision === "approved" ? msg.expenseApproved(t) : msg.expenseRejected(t, e.note), t, "expense", x.id);
      return out;
    }
  }
}

/** notify.event: create the in-app notifications (once each) and queue their delivery. */
async function handleEvent(e: NotifyEvent) {
  await withContext({ platform: true }, async (db) => {
    const targets = await targetsFor(db, e);
    const key = eventKey(e);
    const seen = new Set<string>();
    for (const t of targets) {
      if (seen.has(t.userId)) continue; // one notification per person per event
      seen.add(t.userId);
      const [row] = await db
        .insert(notifications)
        .values({
          tenantId: t.tenantId,
          userId: t.userId,
          kind: t.draft.kind,
          title: t.draft.title,
          body: t.draft.body,
          link: t.link,
          entityType: t.entityType,
          entityId: t.entityId,
          dedupeKey: `${key}:${t.draft.kind}`,
        })
        .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
        .returning({ id: notifications.id });
      if (row) await enqueue(db, { tenantId: t.tenantId, type: "notify.deliver", payload: { notificationId: row.id }, dedupeKey: `deliver:${row.id}` });
    }
  });
}

const dayStartManila = () => {
  const m = new Date(Date.now() + 8 * 3600_000);
  m.setUTCHours(0, 0, 0, 0);
  return new Date(m.getTime() - 8 * 3600_000);
};
const smsDailyLimit = () => Number(process.env.SMS_DAILY_LIMIT ?? 10);

/**
 * notify.deliver: try Web Push to the person's devices; if that did not reach them and the item is urgent, fall back
 * to SMS (opt-in, capped per day). Each channel is recorded once per notification, so a retry only does what is left.
 * Transient failures throw so the queue retries with backoff; permanent ones are recorded and not retried.
 */
async function deliver({ notificationId }: { notificationId: string }) {
  // Recorded results must commit even when a retry is needed, so the failure is raised only after the transaction ends.
  const retryReason = await withContext({ platform: true }, async (db): Promise<string | null> => {
    const [n] = await db.select().from(notifications).where(eq(notifications.id, notificationId));
    if (!n) return null;
    const deliveries = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, notificationId));
    const get = (c: string) => deliveries.find((d) => d.channel === c);
    const record = async (channel: string, status: string, detail: string | null, attempts: number) =>
      db
        .insert(notificationDeliveries)
        .values({ notificationId, channel, status, detail, attempts, sentAt: status === "sent" ? new Date() : null })
        .onConflictDoUpdate({ target: [notificationDeliveries.notificationId, notificationDeliveries.channel], set: { status, detail, attempts, sentAt: status === "sent" ? new Date() : null, updatedAt: new Date() } });
    const urgent = isUrgent(n.kind);
    let retry: string | null = null;

    // ---- push
    let pushStatus = get("push")?.status;
    if (!pushStatus || pushStatus === "failed") {
      const sender = getPushSender();
      const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, n.userId));
      const attempts = (get("push")?.attempts ?? 0) + 1;
      if (!sender.configured()) {
        pushStatus = "none";
        await record("push", "none", "Web Push is not configured", attempts);
      } else if (subs.length === 0) {
        pushStatus = "none";
        await record("push", "none", "no device has push turned on", attempts);
      } else {
        let sent = 0;
        let transient: string | null = null;
        let permanent: string | null = null;
        for (const s of subs) {
          const r = await sender.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, { title: n.title, body: n.body, link: n.link, tag: n.id }, urgent);
          if (r.status === "sent") {
            sent++;
            await db.update(pushSubscriptions).set({ lastSuccessAt: new Date() }).where(eq(pushSubscriptions.id, s.id));
          } else if (r.status === "gone") {
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id)); // the device unsubscribed
          } else if (r.retryable) transient = r.detail;
          else permanent = r.detail;
        }
        if (sent > 0) {
          pushStatus = "sent";
          await record("push", "sent", `${sent} device(s)`, attempts);
        } else if (transient) {
          pushStatus = "failed";
          retry = `push: ${transient}`;
          await record("push", "failed", transient, attempts);
        } else {
          pushStatus = "none";
          await record("push", "none", permanent ?? "no working device", attempts);
        }
      }
    }
    if (retry) return retry; // try again later; SMS waits for the final push outcome

    // ---- SMS fallback
    const sms = get("sms");
    if (!sms || sms.status === "failed") {
      const attempts = (sms?.attempts ?? 0) + 1;
      if (pushStatus === "sent") {
        await record("sms", "skipped", "push delivered", attempts);
      } else if (!urgent) {
        await record("sms", "skipped", "not urgent", attempts);
      } else {
        const [st] = await db.select().from(userNotificationSettings).where(eq(userNotificationSettings.userId, n.userId));
        if (!st?.smsEnabled || !st.phone) {
          await record("sms", "skipped", "SMS is off for this person", attempts);
        } else {
          const [{ c }] = await db
            .select({ c: sql<number>`count(*)::int` })
            .from(notificationDeliveries)
            .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
            .where(and(eq(notifications.userId, n.userId), eq(notificationDeliveries.channel, "sms"), eq(notificationDeliveries.status, "sent"), gte(notificationDeliveries.sentAt, dayStartManila())));
          if (c >= smsDailyLimit()) {
            await record("sms", "skipped", "daily SMS limit reached", attempts);
          } else {
            const r = await getSmsProvider().send(st.phone, `Truckwise: ${n.title}. ${n.body}`.slice(0, 300));
            if (r.ok) await record("sms", "sent", getSmsProvider().real ? "sent" : "stub provider: nothing was really sent", attempts);
            else if (r.retryable) {
              await record("sms", "failed", r.detail, attempts);
              return `sms: ${r.detail}`;
            } else await record("sms", "failed", r.detail, 99);
          }
        }
      }
    }
    return null;
  });
  if (retryReason) throw new Error(retryReason);
}

/**
 * Timers. Safe to run every minute: expire overdue offers (which tells dispatch), and escalate delivery
 * exceptions nobody has looked at for a while (each exception escalates once).
 */
export async function runAutomations(opts: { escalateAfterMs?: number } = {}) {
  const { sweepExpiredOffers } = await import("../services/offers");
  const tenantRows = await withContext({ platform: true }, (db) => db.select({ id: tenants.id }).from(tenants).where(eq(tenants.kind, "hauler")));
  let expired = 0;
  for (const t of tenantRows) expired += await sweepExpiredOffers(t.id);
  const escalated = await escalateExceptions(opts.escalateAfterMs ?? Number(process.env.EXCEPTION_ESCALATION_MINUTES ?? 30) * 60_000);
  const { purgeOldLoginAttempts } = await import("../auth/login-limit");
  await purgeOldLoginAttempts();
  const { runSubscriptionSweep } = await import("../services/admin");
  const subs = await runSubscriptionSweep();
  return { expired, escalated, subscriptionsExpired: subs.expired, subscriptionReminders: subs.reminded };
}

async function escalateExceptions(olderThanMs: number): Promise<number> {
  return withContext({ platform: true }, async (db) => {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await db
      .select({ s: epodSubmissions })
      .from(epodSubmissions)
      .innerJoin(trips, eq(trips.id, epodSubmissions.tripId))
      .where(and(eq(epodSubmissions.status, "pending"), sql`${epodSubmissions.outcome} <> 'complete'`, lte(epodSubmissions.uploadedAt, cutoff), eq(trips.status, "delivery_exception")));
    for (const { s } of rows) {
      await emitEvent(db, { type: "pod.exception_escalated", tenantId: s.tenantId, tripId: s.tripId, submissionId: s.id });
    }
    return rows.length;
  });
}

registerJob("notify.event", handleEvent as never);
registerJob("notify.deliver", deliver as never);
registerJob("automation.tick", (async () => {
  const r = await runAutomations();
  if (r.expired || r.escalated || r.subscriptionsExpired) logger.info(r, "automation tick");
}) as never);

/** Queue this minute's timer job. Several servers doing it at once still produce one job. */
export async function enqueueAutomationTick() {
  const minute = new Date().toISOString().slice(0, 16);
  await withContext({ platform: true }, (db) => enqueue(db, { tenantId: null, type: "automation.tick", payload: {}, dedupeKey: `tick:${minute}`, maxAttempts: 2 }));
}
