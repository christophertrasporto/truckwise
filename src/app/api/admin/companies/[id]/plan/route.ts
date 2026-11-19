import { requireActor, route } from "@/server/http";
import { changePlan } from "@/server/services/admin";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  await changePlan(requireActor(ctx), id, await req.json(), { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
