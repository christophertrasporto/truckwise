import { boardFilters } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { listPartnerBoard } from "@/server/services/partner";
import { queryObject } from "@/server/query";

export const GET = route(async (req, ctx) => Response.json(await listPartnerBoard(requireTenantActor(ctx), boardFilters.parse(queryObject(req)))));
