import { requireTenantActor, route } from "@/server/http";
import { listMySettlements } from "@/server/services/finance/settlements";

export const GET = route(async (_req, ctx) => Response.json({ settlements: await listMySettlements(requireTenantActor(ctx)) }));
