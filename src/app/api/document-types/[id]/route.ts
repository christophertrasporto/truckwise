import { requireTenantActor, route } from "@/server/http";
import { updateDocumentType } from "@/server/services/documents";

export const PATCH = route<{ id: string }>(async (req, ctx, { id }) => {
  await updateDocumentType(requireTenantActor(ctx), id, await req.json(), { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
