import { requireTenantActor, route } from "@/server/http";
import { partnerDecline } from "@/server/services/partner";

export const POST = route<{ haulerId: string; tripId: string }>(async (_req, ctx, p) => {
  await partnerDecline(requireTenantActor(ctx), p.haulerId, p.tripId, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
