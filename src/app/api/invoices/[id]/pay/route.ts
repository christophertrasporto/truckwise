import { requireTenantActor, route } from "@/server/http";
import { markInvoicePaid, markPaidInput } from "@/server/services/finance/invoices";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  await markInvoicePaid(requireTenantActor(ctx), id, markPaidInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
