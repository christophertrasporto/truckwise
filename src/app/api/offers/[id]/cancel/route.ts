import { requireTenantActor, route } from "@/server/http";
import { cancelOffer } from "@/server/services/offers";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  await cancelOffer(requireTenantActor(ctx), id, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
