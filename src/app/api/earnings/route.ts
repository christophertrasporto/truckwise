import { requireTenantActor, route } from "@/server/http";
import { driverEarnings } from "@/server/services/finance/earnings";

export const GET = route(async (_req, ctx) => Response.json(await driverEarnings(requireTenantActor(ctx))));
