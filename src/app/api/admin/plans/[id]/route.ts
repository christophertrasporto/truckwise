import { requireActor, route } from "@/server/http";
import { updatePlan } from "@/server/services/admin";

export const PUT = route<{ id: string }>(async (req, ctx, { id }) => {
  await updatePlan(requireActor(ctx), id, await req.json(), { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
