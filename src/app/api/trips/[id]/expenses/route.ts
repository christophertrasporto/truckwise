import { expenseInput, addCompanyExpense, listMyTripExpenses, submitExpense } from "@/server/services/finance/expenses";
import { listTripExpenses } from "@/server/services/finance/expenses";
import { HttpError } from "@/server/errors";
import { requireTenantActor, route } from "@/server/http";

/** A driver sees their own expenses on the trip; finance staff see all of them. */
export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  const actor = requireTenantActor(ctx);
  const expenses = actor.role === "driver" ? await listMyTripExpenses(actor, id) : await listTripExpenses(actor, id);
  return Response.json({ expenses });
});

/**
 * multipart/form-data: category, amountCentavos, incurredAt, note, idempotencyKey and a "receipt" photo.
 * A driver reports their own cost (needs review); office staff enter a company-paid cost (approved at once).
 */
export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const actor = requireTenantActor(ctx);
  const form = await req.formData().catch(() => {
    throw new HttpError(400, "Expected a multipart form");
  });
  const fields: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && v !== "") fields[k] = v;
  const input = expenseInput.parse({ ...fields, amountCentavos: Number(fields.amountCentavos) });
  const file = form.get("receipt");
  const receipt = file && typeof file !== "string" && file.size > 0 ? { name: file.name || "receipt", data: Buffer.from(await file.arrayBuffer()) } : null;
  const res = actor.role === "driver" ? await submitExpense(actor, id, input, receipt, { requestId: ctx.requestId }) : await addCompanyExpense(actor, id, input, receipt, { requestId: ctx.requestId });
  return Response.json(res, { status: res.duplicate ? 200 : 201 });
});
