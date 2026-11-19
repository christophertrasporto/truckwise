import { requireTenantActor, route } from "@/server/http";
import { getSettlement } from "@/server/services/finance/settlements";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => Response.json(await getSettlement(requireTenantActor(ctx), id)));
