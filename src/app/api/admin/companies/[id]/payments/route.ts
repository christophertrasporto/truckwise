import { requireActor, route } from "@/server/http";
import { recordPayment } from "@/server/services/admin";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const res = await recordPayment(requireActor(ctx), id, await req.json(), { requestId: ctx.requestId });
  return Response.json(res, { status: res.duplicate ? 200 : 201 });
});
