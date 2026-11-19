import { requireTenantActor, route } from "@/server/http";
import { removeTripDocument } from "@/server/services/documents";

export const POST = route<{ docId: string }>(async (_req, ctx, { docId }) => {
  await removeTripDocument(requireTenantActor(ctx), docId, { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
