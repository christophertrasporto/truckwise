import { advanceInput } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { advanceTrip } from "@/server/services/trips";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const { to } = advanceInput.parse(await req.json());
  await advanceTrip(requireTenantActor(ctx), id, to, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
