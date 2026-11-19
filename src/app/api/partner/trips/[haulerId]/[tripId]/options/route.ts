import { requireTenantActor, route } from "@/server/http";
import { partnerOptions } from "@/server/services/partner";

export const GET = route<{ haulerId: string; tripId: string }>(async (_req, ctx, p) =>
  Response.json(await partnerOptions(requireTenantActor(ctx), p.haulerId, p.tripId)),
);
