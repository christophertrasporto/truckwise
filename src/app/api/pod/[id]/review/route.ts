import { reviewInput } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { reviewPod } from "@/server/services/pod";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const res = await reviewPod(requireTenantActor(ctx), id, reviewInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res);
});
