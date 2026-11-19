import { claimInput } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { claimTrip } from "@/server/services/offers";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const input = claimInput.parse(await req.json());
  return Response.json(await claimTrip(requireTenantActor(ctx), id, input, { requestId: ctx.requestId }));
});
