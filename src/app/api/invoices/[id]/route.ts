import { requireTenantActor, route } from "@/server/http";
import { getInvoice } from "@/server/services/finance/invoices";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => Response.json(await getInvoice(requireTenantActor(ctx), id)));
