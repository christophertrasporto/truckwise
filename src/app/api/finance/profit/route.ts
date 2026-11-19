import { requireTenantActor, route } from "@/server/http";
import { profitSummary } from "@/server/services/finance/profit";
import { queryObject } from "@/server/query";

export const GET = route(async (req, ctx) => Response.json(await profitSummary(requireTenantActor(ctx), { onlyCompleted: !queryObject(req).all })));
