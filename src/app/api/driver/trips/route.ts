import { boardFilters } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { listDriverBoard, listMyTrips } from "@/server/services/offers";
import { queryObject } from "@/server/query";

/** Internal drivers: the available-trips board (direct vs broadcast) and their accepted trips. */
export const GET = route(async (req, ctx) => {
  const actor = requireTenantActor(ctx);
  const filters = boardFilters.parse(queryObject(req));
  return Response.json({ board: await listDriverBoard(actor, filters), mine: await listMyTrips(actor) });
});
