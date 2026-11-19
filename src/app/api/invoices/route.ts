import { z } from "zod";
import { requireTenantActor, route } from "@/server/http";
import { generateInvoice, generateInvoiceInput, invoiceAllReady, invoiceableTrips, listInvoices } from "@/server/services/finance/invoices";
import { queryObject } from "@/server/query";

/** GET: issued invoices, or with ?ready=1 the finished trips that can be billed now, grouped by client. */
export const GET = route(async (req, ctx) => {
  const actor = requireTenantActor(ctx);
  if (queryObject(req).ready) return Response.json({ ready: await invoiceableTrips(actor) });
  return Response.json({ invoices: await listInvoices(actor) });
});

const all = z.object({ customerId: z.string().uuid(), all: z.literal(true), idempotencyKey: z.string().min(8).max(100) });

/** POST: issue an invoice for chosen trips, or for every ready trip of one client (all: true). Repeat-safe via idempotencyKey. */
export const POST = route(async (req, ctx) => {
  const actor = requireTenantActor(ctx);
  const body = await req.json();
  if (body?.all) {
    const i = all.parse(body);
    return Response.json(await invoiceAllReady(actor, i.customerId, i.idempotencyKey, { requestId: ctx.requestId }));
  }
  const res = await generateInvoice(actor, generateInvoiceInput.parse(body), { requestId: ctx.requestId });
  return Response.json(res, { status: res.duplicate ? 200 : 201 });
});
