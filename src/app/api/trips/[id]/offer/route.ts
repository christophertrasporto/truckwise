import { offerInput } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { createOffer } from "@/server/services/offers";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const actor = requireTenantActor(ctx);
  const res = await createOffer(actor, id, offerInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res, { status: 201 });
});
