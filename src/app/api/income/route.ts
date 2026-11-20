import { requireTenantActor, route } from "@/server/http";
import { queryObject } from "@/server/query";
import { addIncome, incomeLedger, incomeInput } from "@/server/services/finance/income";

export const GET = route(async (req, ctx) => {
  const q = queryObject(req);
  const month = typeof q.month === "string" ? q.month : new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
  return Response.json(await incomeLedger(requireTenantActor(ctx), { month, customerId: typeof q.customerId === "string" ? q.customerId : undefined }));
});

export const POST = route(async (req, ctx) => Response.json(await addIncome(requireTenantActor(ctx), incomeInput.parse(await req.json()), { requestId: ctx.requestId }), { status: 201 }));
