import { HttpError } from "@/server/errors";
import { requireTenantActor, route } from "@/server/http";
import { uploadDocument } from "@/server/services/documents";

/** multipart/form-data with one field, `file`: a photo or a PDF. */
export const POST = route<{ id: string; docId: string }>(async (req, ctx, { id, docId }) => {
  const form = await req.formData().catch(() => {
    throw new HttpError(400, "Expected a multipart form");
  });
  const f = form.get("file");
  if (!f || typeof f === "string") throw new HttpError(400, "Choose a file to upload");
  const res = await uploadDocument(requireTenantActor(ctx), id, docId, { name: f.name || "document", data: Buffer.from(await f.arrayBuffer()) }, { requestId: ctx.requestId });
  return Response.json(res, { status: 201 });
});
