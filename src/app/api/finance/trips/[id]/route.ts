import { requireTenantActor, route } from "@/server/http";
import { tripFinancials } from "@/server/services/finance/profit";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => Response.json(await tripFinancials(requireTenantActor(ctx), id)));
