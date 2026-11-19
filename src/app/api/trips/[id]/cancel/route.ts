import { requireTenantActor, route } from "@/server/http";
import { cancelTrip } from "@/server/services/trips";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  await cancelTrip(requireTenantActor(ctx), id, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
