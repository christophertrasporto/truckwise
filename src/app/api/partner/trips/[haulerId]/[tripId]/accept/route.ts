import { partnerAcceptInput } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { partnerAccept } from "@/server/services/partner";

export const POST = route<{ haulerId: string; tripId: string }>(async (req, ctx, p) => {
  const input = partnerAcceptInput.parse(await req.json());
  return Response.json(await partnerAccept(requireTenantActor(ctx), p.haulerId, p.tripId, input, { requestId: ctx.requestId }));
});
