import { z } from "zod";
import { requireTenantActor, route } from "@/server/http";
import { setPartnerStatus } from "@/server/services/partners";

const body = z.object({ status: z.enum(["approved", "revoked"]) });

export const POST = route<{ tenantId: string }>(async (req, ctx, { tenantId }) => {
  await setPartnerStatus(requireTenantActor(ctx), tenantId, body.parse(await req.json()).status, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
