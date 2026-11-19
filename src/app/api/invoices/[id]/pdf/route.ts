import { requireTenantActor, route } from "@/server/http";
import { invoicePdf } from "@/server/services/finance/invoice-pdf";

/** The invoice as a PDF with the approved proof of delivery of every trip attached. */
export const GET = route<{ id: string }>(async (_req, ctx, { id }) => {
  const { filename, data } = await invoicePdf(requireTenantActor(ctx), id);
  return new Response(Buffer.from(data), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${filename}"`, "cache-control": "private, no-store" },
  });
});
