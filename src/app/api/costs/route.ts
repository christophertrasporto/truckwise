import { requireTenantActor, route } from "@/server/http";
import { queryObject } from "@/server/query";
import { addCost, costInput, costLedger } from "@/server/services/finance/costs";

const thisMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);

export const GET = route(async (req, ctx) => {
  const q = queryObject(req);
  return Response.json(await costLedger(requireTenantActor(ctx), { month: q.month ?? thisMonth(), category: q.category }));
});

export const POST = route(async (req, ctx) => {
  const res = await addCost(requireTenantActor(ctx), costInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res, { status: res.duplicate ? 200 : 201 });
});
