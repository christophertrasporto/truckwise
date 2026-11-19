import { ZodError } from "zod";
import { applicationInput, photoField, PHOTO_KINDS } from "@/shared/application";
import { HttpError } from "@/server/errors";
import { logger } from "@/server/logger";
import { submitApplication, type ApplicationFile } from "@/server/services/applications";

/**
 * Public application form (multipart). The six photos are fields named left, right, front, back, plate and license.
 * Errors are plain messages a trucker can act on; nothing about the system is revealed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    // Ten trucks with six photos each is a lot of data: refuse absurd bodies before reading them.
    if (Number(req.headers.get("content-length") ?? 0) > 250 * 1024 * 1024) throw new HttpError(413, "These photos are too large to send at once. Use smaller photos.");
    const form = await req.formData().catch(() => {
      throw new HttpError(400, "Please submit the form again");
    });
    const fields: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) if (typeof v === "string" && v.trim() !== "") fields[k] = v;
    if (typeof fields.extraTrucks === "string") {
      try {
        fields.extraTrucks = JSON.parse(fields.extraTrucks);
      } catch {
        throw new HttpError(400, "Please submit the form again");
      }
    }
    const input = applicationInput.parse(fields);
    const files: ApplicationFile[] = [];
    for (let truck = 0; truck <= input.extraTrucks.length; truck++) {
      for (const kind of PHOTO_KINDS) {
        const f = form.get(photoField(truck, kind));
        if (f && typeof f !== "string" && f.size > 0) files.push({ truck, kind, name: f.name || kind, data: Buffer.from(await f.arrayBuffer()) });
      }
    }
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    const res = await submitApplication(token, input, files, { ip });
    return Response.json({ received: res.received }, { status: 201 });
  } catch (err) {
    if (err instanceof ZodError) return Response.json({ error: err.issues.map((i) => i.message).join(". ") }, { status: 400 });
    if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
    logger.error({ err }, "application submit failed");
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
