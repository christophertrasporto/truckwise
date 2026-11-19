import { decideInput } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { decideApplication } from "@/server/services/offers";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const res = await decideApplication(requireTenantActor(ctx), id, decideInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res);
});
