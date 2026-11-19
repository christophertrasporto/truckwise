import { requireTenantActor, route } from "@/server/http";
import { moneyEditInput, updateTripMoney } from "@/server/services/finance/money";

export const PATCH = route<{ id: string }>(async (req, ctx, { id }) => {
  const res = await updateTripMoney(requireTenantActor(ctx), id, moneyEditInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res);
});
