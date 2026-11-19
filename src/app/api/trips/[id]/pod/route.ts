import { after } from "next/server";
import { podInput } from "@/shared/schemas/trip";
import { HttpError } from "@/server/errors";
import { requireTenantActor, route } from "@/server/http";
import "@/server/jobs/handlers";
import { drainJobs } from "@/server/jobs/queue";
import { submitPod, type UploadedFile } from "@/server/services/pod";

/**
 * multipart/form-data: text fields per podInput, plus `photos` (one or more), optional `signature` (PNG)
 * and optional `pdfs`. Scanning and display copies run as a background job right after the response.
 */
export const POST = route<{ id: string }>(async (req, ctx, { id }) => {
  const actor = requireTenantActor(ctx);
  const form = await req.formData().catch(() => {
    throw new HttpError(400, "Expected a multipart form");
  });
  const fields: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && v !== "") fields[k] = v;
  const input = podInput.parse(fields);

  const files: UploadedFile[] = [];
  for (const [field, kind] of [["photos", "photo"], ["signature", "signature"], ["pdfs", "pdf"]] as const) {
    for (const f of form.getAll(field)) {
      if (typeof f === "string" || f.size === 0) continue;
      files.push({ name: f.name || field, kind, data: Buffer.from(await f.arrayBuffer()) });
    }
  }

  const res = await submitPod(actor, id, input, files, { requestId: ctx.requestId });
  if (!res.duplicate) after(() => drainJobs().then(() => undefined));
  return Response.json(res, { status: res.duplicate ? 200 : 201 });
});
