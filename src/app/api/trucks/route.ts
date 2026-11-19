import { requireTenantActor, route } from "@/server/http";
import { addTruck, listTrucks, truckInput } from "@/server/services/fleet";

export const GET = route(async (_req, ctx) => Response.json({ trucks: await listTrucks(requireTenantActor(ctx)) }));
export const POST = route(async (req, ctx) => {
  const res = await addTruck(requireTenantActor(ctx), truckInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res, { status: 201 });
});
