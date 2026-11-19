/**
 * What each notification says. Deliberately free of money: no customer rate, payout, expense amount or total ever
 * appears in a notification, so nothing sensitive can reach a lock screen, a push service or an SMS gateway.
 */
export interface TripFacts {
  tripId: string;
  hauler: string;
  reference: string;
  origin: string;
  destination: string;
}

export type Kind =
  | "offer.new"
  | "offer.direct"
  | "offer.open_call"
  | "offer.closed"
  | "offer.expired"
  | "offer.declined"
  | "application.new"
  | "application.approved"
  | "application.declined"
  | "trip.claimed"
  | "trip.assigned"
  | "assignment.released"
  | "trip.cancelled"
  | "trip.arrived_pickup"
  | "trip.arrived_destination"
  | "trip.completed"
  | "invoice.ready"
  | "pod.submitted"
  | "pod.exception"
  | "pod.exception_escalated"
  | "pod.approved"
  | "pod.rejected"
  | "pod.more_requested"
  | "settlement.issued"
  | "settlement.paid"
  | "subcon.application"
  | "subscription.expiring"
  | "expense.submitted"
  | "expense.approved"
  | "expense.rejected";

/** Items worth a text message when a person cannot be reached by push: something is waiting on them. */
const URGENT = new Set<Kind>([
  "offer.new",
  "offer.direct",
  "offer.open_call",
  "application.approved",
  "application.declined",
  "trip.assigned",
  "assignment.released",
  "trip.cancelled",
  "pod.rejected",
  "pod.more_requested",
  "pod.exception_escalated",
]);
export const isUrgent = (k: string) => URGENT.has(k as Kind);

export const routeLine = (t: TripFacts) => `${t.reference}: ${t.origin} to ${t.destination}`;

/** Which in-app page a recipient should land on. Subcontractor managers see the trip through the partner view. */
export function tripLink(role: string, t: TripFacts): string {
  if (role === "sub_owner" || role === "sub_manager") return `/app/partner/${t.hauler}/${t.tripId}`;
  return `/app/trips/${t.tripId}`;
}

export interface Draft {
  kind: Kind;
  title: string;
  body: string;
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const msg = {
  offerNew: (t: TripFacts): Draft => ({ kind: "offer.new", title: "New trip available", body: routeLine(t) }),
  offerDirect: (t: TripFacts): Draft => ({ kind: "offer.direct", title: "A trip was offered to you", body: routeLine(t) }),
  offerOpenCall: (t: TripFacts): Draft => ({ kind: "offer.open_call", title: "Open call: apply for a trip", body: routeLine(t) }),
  offerClosed: (t: TripFacts): Draft => ({ kind: "offer.closed", title: "Trip already taken", body: `${routeLine(t)} was accepted by someone else.` }),
  offerExpired: (t: TripFacts): Draft => ({ kind: "offer.expired", title: "Offer timed out", body: `Nobody took ${routeLine(t)} in time. Offer it again or choose someone.` }),
  offerDeclined: (t: TripFacts, by: string): Draft => ({ kind: "offer.declined", title: "Offer declined", body: `${by} declined ${routeLine(t)}.` }),
  applicationNew: (t: TripFacts, who: string): Draft => ({ kind: "application.new", title: "Request to take a trip", body: `${who} wants ${routeLine(t)}.` }),
  applicationApproved: (t: TripFacts): Draft => ({ kind: "application.approved", title: "Your request was approved", body: `${routeLine(t)} is yours.` }),
  applicationDeclined: (t: TripFacts, reason: string | null): Draft => ({ kind: "application.declined", title: "Your request was declined", body: clip(`${routeLine(t)}${reason ? `. ${reason}` : ""}`) }),
  tripClaimed: (t: TripFacts, who: string): Draft => ({ kind: "trip.claimed", title: "Trip accepted", body: `${who} accepted ${routeLine(t)}.` }),
  tripAssigned: (t: TripFacts): Draft => ({ kind: "trip.assigned", title: "You have a new trip", body: routeLine(t) }),
  released: (t: TripFacts, reason: string): Draft => ({ kind: "assignment.released", title: "You were taken off a trip", body: clip(`${routeLine(t)}. ${reason}`) }),
  cancelled: (t: TripFacts): Draft => ({ kind: "trip.cancelled", title: "Trip cancelled", body: `${routeLine(t)} was cancelled.` }),
  arrivedPickup: (t: TripFacts, who: string): Draft => ({ kind: "trip.arrived_pickup", title: "Driver at pickup", body: `${who} arrived at the pickup for ${t.reference}.` }),
  arrivedDestination: (t: TripFacts, who: string): Draft => ({ kind: "trip.arrived_destination", title: "Driver at destination", body: `${who} arrived at the destination for ${t.reference}.` }),
  completed: (t: TripFacts): Draft => ({ kind: "trip.completed", title: "Trip completed", body: `${t.reference} is complete: proof approved.` }),
  invoiceReady: (t: TripFacts): Draft => ({ kind: "invoice.ready", title: "Ready to invoice", body: `${routeLine(t)} can be billed.` }),
  podSubmitted: (t: TripFacts, version: number): Draft => ({ kind: "pod.submitted", title: "Proof of delivery to review", body: `${t.reference}: new proof (version ${version}).` }),
  podException: (t: TripFacts, outcome: string): Draft => ({ kind: "pod.exception", title: "Delivery exception", body: `${t.reference}: ${outcome}. It needs a decision.` }),
  podEscalated: (t: TripFacts): Draft => ({ kind: "pod.exception_escalated", title: "Exception still waiting", body: `${t.reference} has a delivery exception nobody has reviewed yet.` }),
  podApproved: (t: TripFacts, auto: boolean): Draft => ({ kind: "pod.approved", title: "Proof approved", body: `${t.reference}: your proof of delivery was approved${auto ? " automatically" : ""}.` }),
  podRejected: (t: TripFacts, reason: string | null): Draft => ({ kind: "pod.rejected", title: "Proof rejected: send it again", body: clip(`${t.reference}${reason ? `: ${reason}` : ""}`) }),
  podMore: (t: TripFacts, reason: string | null): Draft => ({ kind: "pod.more_requested", title: "More proof needed", body: clip(`${t.reference}${reason ? `: ${reason}` : ""}`) }),
  settlementIssued: (number: string): Draft => ({ kind: "settlement.issued", title: "New settlement", body: `Settlement ${number} was issued to your company.` }),
  settlementPaid: (number: string): Draft => ({ kind: "settlement.paid", title: "Settlement paid", body: `Settlement ${number} was marked as paid.` }),
  subscriptionExpiring: (periodEnd: string): Draft => ({ kind: "subscription.expiring", title: "Your subscription ends soon", body: `Your plan runs out on ${periodEnd}. Contact the platform administrator to renew so your team keeps access.` }),
  subconApplied: (company: string): Draft => ({ kind: "subcon.application", title: "New subcontractor application", body: `${company} applied to become a subcontractor.` }),
  expenseSubmitted: (t: TripFacts, who: string): Draft => ({ kind: "expense.submitted", title: "Expense to review", body: `${who} reported an expense on ${t.reference}.` }),
  expenseApproved: (t: TripFacts): Draft => ({ kind: "expense.approved", title: "Expense approved", body: `Your expense on ${t.reference} was approved.` }),
  expenseRejected: (t: TripFacts, note: string | null): Draft => ({ kind: "expense.rejected", title: "Expense rejected", body: clip(`Your expense on ${t.reference} was rejected${note ? `: ${note}` : ""}.`) }),
};
