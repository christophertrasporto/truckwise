import { reviewApplicationInput } from "@/shared/application";
import { requireTenantActor, route } from "@/server/http";
import { reviewApplication } from "@/server/services/applications";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const res = await reviewApplication(requireTenantActor(ctx), id, reviewApplicationInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res);
});
