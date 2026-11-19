import { requireTenantActor, route } from "@/server/http";
import { expenseReviewInput, reviewExpense } from "@/server/services/finance/expenses";

export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const res = await reviewExpense(requireTenantActor(ctx), id, expenseReviewInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res);
});
