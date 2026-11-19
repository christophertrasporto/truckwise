import { z } from "zod";
import { requireTenantActor, route } from "@/server/http";
import { generateSettlement, generateSettlementInput, listSettlements, settleAllReady, settleableTrips } from "@/server/services/finance/settlements";
import { queryObject } from "@/server/query";

export const GET = route(async (req, ctx) => {
  const actor = requireTenantActor(ctx);
  if (queryObject(req).ready) return Response.json({ ready: await settleableTrips(actor) });
  return Response.json({ settlements: await listSettlements(actor) });
});

const all = z.object({ partnerTenantId: z.string().uuid(), all: z.literal(true), idempotencyKey: z.string().min(8).max(100) });

export const POST = route(async (req, ctx) => {
  const actor = requireTenantActor(ctx);
  const body = await req.json();
  if (body?.all) {
    const i = all.parse(body);
    return Response.json(await settleAllReady(actor, i.partnerTenantId, i.idempotencyKey, { requestId: ctx.requestId }));
  }
  const res = await generateSettlement(actor, generateSettlementInput.parse(body), { requestId: ctx.requestId });
  return Response.json(res, { status: res.duplicate ? 200 : 201 });
});
