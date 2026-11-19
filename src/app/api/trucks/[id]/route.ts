import { requireTenantActor, route } from "@/server/http";
import { truckPatch, updateTruck } from "@/server/services/fleet";

export const PATCH = route<{ id: string }>(async (req, ctx, { id }) => {
  await updateTruck(requireTenantActor(ctx), id, truckPatch.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
