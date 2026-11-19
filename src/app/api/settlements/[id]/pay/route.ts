import { requireTenantActor, route } from "@/server/http";
import { markPaidInput } from "@/server/services/finance/invoices";
import { markSettlementPaid } from "@/server/services/finance/settlements";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  await markSettlementPaid(requireTenantActor(ctx), id, markPaidInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
