import { requireTenantActor, route } from "@/server/http";
import { getTripForDriver, getTripForStaff } from "@/server/services/trip-detail";

type P = { id: string };

/** One URL, audience-specific payload: staff get the full trip, drivers get the driver shape (no contract rate). */
export const GET = route<P>(async (_req, ctx, { id }) => {
  const actor = requireTenantActor(ctx);
  const data = actor.role === "driver" ? await getTripForDriver(actor, id) : await getTripForStaff(actor, id);
  return Response.json(data);
});
