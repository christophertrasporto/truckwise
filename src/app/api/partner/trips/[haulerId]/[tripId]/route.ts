import { requireTenantActor, route } from "@/server/http";
import { getTripForPartner } from "@/server/services/partner";

export const GET = route<{ haulerId: string; tripId: string }>(async (_req, ctx, p) =>
  Response.json(await getTripForPartner(requireTenantActor(ctx), p.haulerId, p.tripId)),
);
