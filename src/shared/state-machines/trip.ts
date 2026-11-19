export type TripStatus =
  | "created"
  | "offered"
  | "assigned"
  | "started"
  | "arrived_pickup"
  | "loaded"
  | "in_transit"
  | "arrived_destination"
  | "pod_submitted"
  | "delivery_exception"
  | "ready_for_invoice"
  | "cancelled";

/** Allowed transitions. Anything not listed is rejected, and every transition writes a status event. */
export const tripTransitions: Record<TripStatus, readonly TripStatus[]> = {
  created: ["offered", "cancelled"],
  offered: ["assigned", "created", "cancelled"],
  // Reassignment (before cargo is loaded) sends the trip back to "created" so dispatch can offer it again.
  assigned: ["started", "offered", "created", "cancelled"],
  started: ["arrived_pickup", "created"],
  arrived_pickup: ["loaded", "created"],
  loaded: ["in_transit"],
  in_transit: ["arrived_destination"],
  // Complete proof -> pod_submitted; partial/discrepancy/failed proof -> delivery_exception.
  // With several delivery stops the trip stays here until every stop has proof. Policy-approved proof can finish it directly.
  arrived_destination: ["pod_submitted", "delivery_exception", "ready_for_invoice"],
  // Rejection or "request more" sends the driver back to resubmit.
  pod_submitted: ["ready_for_invoice", "arrived_destination", "delivery_exception"],
  delivery_exception: ["ready_for_invoice", "arrived_destination", "pod_submitted"],
  ready_for_invoice: [],
  cancelled: [],
};

/** The steps a driver advances one at a time from the trip screen. */
export const driverSteps: Partial<Record<TripStatus, TripStatus>> = {
  assigned: "started",
  started: "arrived_pickup",
  arrived_pickup: "loaded",
  loaded: "in_transit",
  in_transit: "arrived_destination",
};

export function canTransition(from: TripStatus, to: TripStatus): boolean {
  return tripTransitions[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly status = 409;
  constructor(from: TripStatus, to: TripStatus) {
    super(`Trip cannot move from ${from} to ${to}`);
  }
}

export function assertTransition(from: TripStatus, to: TripStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const tripStatusLabel: Record<TripStatus, string> = {
  created: "Created",
  offered: "Offered",
  assigned: "Assigned",
  started: "Started",
  arrived_pickup: "At pickup",
  loaded: "Loaded",
  in_transit: "In transit",
  arrived_destination: "At destination",
  pod_submitted: "Proof submitted",
  delivery_exception: "Delivery exception",
  ready_for_invoice: "Ready for invoice",
  cancelled: "Cancelled",
};
