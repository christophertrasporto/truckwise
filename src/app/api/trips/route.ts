import { createTripInput } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { createTrip, listTripsForStaff } from "@/server/services/trips";

export const GET = route(async (_req, ctx) => {
  const actor = requireTenantActor(ctx);
  return Response.json({ trips: await listTripsForStaff(actor) });
});

export const POST = route(async (req, ctx) => {
  const actor = requireTenantActor(ctx);
  const input = createTripInput.parse(await req.json());
  const res = await createTrip(actor, input, { requestId: ctx.requestId });
  return Response.json(res, { status: 201 });
});
