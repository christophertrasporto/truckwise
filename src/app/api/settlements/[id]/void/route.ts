import { z } from "zod";
import { requireTenantActor, route } from "@/server/http";
import { voidSettlement } from "@/server/services/finance/settlements";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await req.json());
  await voidSettlement(requireTenantActor(ctx), id, reason, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
