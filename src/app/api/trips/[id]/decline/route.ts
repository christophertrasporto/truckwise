import { requireTenantActor, route } from "@/server/http";
import { declineOffer } from "@/server/services/offers";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  await declineOffer(requireTenantActor(ctx), id, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
