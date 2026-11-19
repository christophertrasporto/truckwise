import { reassignInput } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { reassignTrip } from "@/server/services/offers";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const { reason } = reassignInput.parse(await req.json());
  await reassignTrip(requireTenantActor(ctx), id, reason, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
