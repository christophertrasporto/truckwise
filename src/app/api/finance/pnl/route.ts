import { requireTenantActor, route } from "@/server/http";
import { queryObject } from "@/server/query";
import { companyPnl } from "@/server/services/finance/costs";

export const GET = route(async (req, ctx) => {
  const month = queryObject(req).month ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
  return Response.json(await companyPnl(requireTenantActor(ctx), month));
});
