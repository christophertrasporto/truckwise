import { requireTenantActor, route } from "@/server/http";
import { withdrawApplication } from "@/server/services/offers";

export const POST = route<{ id: string }>(async (_req, ctx, { id }) => {
  await withdrawApplication(requireTenantActor(ctx), id, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
