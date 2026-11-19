import { requireTenantActor, route } from "@/server/http";
import { getMySettlement } from "@/server/services/finance/settlements";

export const GET = route<{ haulerId: string; id: string }>(async (_req, ctx, p) =>
  Response.json(await getMySettlement(requireTenantActor(ctx), p.haulerId, p.id)),
);
