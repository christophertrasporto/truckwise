import { z } from "zod";
import { requireTenantActor, route } from "@/server/http";
import { voidCost } from "@/server/services/finance/costs";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await req.json());
  await voidCost(requireTenantActor(ctx), id, reason, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
