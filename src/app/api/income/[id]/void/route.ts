import { z } from "zod";
import { requireTenantActor, route } from "@/server/http";
import { voidIncome } from "@/server/services/finance/income";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(await req.json());
  await voidIncome(requireTenantActor(ctx), id, reason, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
