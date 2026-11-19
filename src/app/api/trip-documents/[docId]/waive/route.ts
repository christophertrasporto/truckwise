import { requireTenantActor, route } from "@/server/http";
import { waiveDocument } from "@/server/services/documents";

export const POST = route<{ docId: string }>(async (req, ctx, { docId }) => {
  await waiveDocument(requireTenantActor(ctx), docId, await req.json(), { requestId: ctx.requestId });
  return Response.json({ ok: true });
});
