import { requireTenantActor, route } from "@/server/http";
import { driverProfileInput, upsertDriverProfile } from "@/server/services/fleet";

export const PUT = route<{ userId: string }>(async (req, ctx, { userId }) => {
  await upsertDriverProfile(requireTenantActor(ctx), userId, driverProfileInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
