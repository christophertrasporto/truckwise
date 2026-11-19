import type { Db } from "../db";
import { enqueue } from "../jobs/queue";

/**
 * Things that happened which people should hear about. A service records the event in the SAME transaction as the
 * change itself (so a change can never happen without its notification, nor a notification without its change).
 * The background worker later decides who is told, and the unique dedupe key means a retry never repeats it.
 */
export type NotifyEvent =
  | { type: "offer.created"; tenantId: string; tripId: string; offerId: string }
  | { type: "offer.expired"; tenantId: string; tripId: string; offerId: string }
  | { type: "offer.declined"; tenantId: string; tripId: string; offerId: string; byUserId: string }
  | { type: "application.created"; tenantId: string; tripId: string; applicationId: string }
  | { type: "application.decided"; tenantId: string; tripId: string; applicationId: string; decision: "approved" | "declined"; reason: string | null }
  | { type: "trip.claimed"; tenantId: string; tripId: string; assignmentId: string; via: "claim" | "approval"; actorUserId: string; applicantUserId: string | null }
  | { type: "assignment.released"; tenantId: string; tripId: string; assignmentId: string; reason: string }
  | { type: "trip.cancelled"; tenantId: string; tripId: string }
  | { type: "trip.status"; tenantId: string; tripId: string; eventId: number; to: "arrived_pickup" | "arrived_destination" | "ready_for_invoice" }
  | { type: "pod.submitted"; tenantId: string; tripId: string; submissionId: string }
  | { type: "pod.reviewed"; tenantId: string; tripId: string; submissionId: string; decision: "approve" | "reject" | "request_more"; automatic: boolean; reason: string | null }
  | { type: "pod.exception_escalated"; tenantId: string; tripId: string; submissionId: string }
  | { type: "settlement.changed"; tenantId: string; settlementId: string; what: "issued" | "paid" }
  | { type: "subcon.applied"; tenantId: string; applicationId: string }
  | { type: "subscription.expiring"; tenantId: string; subscriptionId: string; periodEnd: string }
  | { type: "expense.submitted"; tenantId: string; tripId: string; expenseId: string }
  | { type: "expense.reviewed"; tenantId: string; tripId: string; expenseId: string; decision: "approved" | "rejected"; note: string | null };

/** The key that makes an event happen at most once, however many times its job runs. */
export function eventKey(e: NotifyEvent): string {
  switch (e.type) {
    case "offer.created":
    case "offer.expired":
      return `${e.type}:${e.offerId}`;
    case "offer.declined":
      return `${e.type}:${e.offerId}:${e.byUserId}`;
    case "application.created":
      return `${e.type}:${e.applicationId}`;
    case "application.decided":
      return `${e.type}:${e.applicationId}:${e.decision}`;
    case "trip.claimed":
    case "assignment.released":
      return `${e.type}:${e.assignmentId}`;
    case "trip.cancelled":
      return `${e.type}:${e.tripId}`;
    case "trip.status":
      return `${e.type}:${e.eventId}`;
    case "pod.submitted":
    case "pod.exception_escalated":
      return `${e.type}:${e.submissionId}`;
    case "pod.reviewed":
      return `${e.type}:${e.submissionId}:${e.decision}`;
    case "settlement.changed":
      return `${e.type}:${e.settlementId}:${e.what}`;
    case "subcon.applied":
      return `${e.type}:${e.applicationId}`;
    case "subscription.expiring":
      return `${e.type}:${e.subscriptionId}:${e.periodEnd}`;
    case "expense.submitted":
      return `${e.type}:${e.expenseId}`;
    case "expense.reviewed":
      return `${e.type}:${e.expenseId}:${e.decision}`;
  }
}

/** Record an event inside the caller's transaction. */
export async function emitEvent(db: Db, e: NotifyEvent): Promise<void> {
  const key = eventKey(e);
  await enqueue(db, { tenantId: e.tenantId, type: "notify.event", payload: e, dedupeKey: `ev:${key}` });
}
