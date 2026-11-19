import { cookies } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE, switchTenant } from "@/server/auth/sessions";
import { HttpError, requireActor, route } from "@/server/http";

const body = z.object({ tenantId: z.string().uuid() });

export const POST = route(async (req, ctx) => {
  const actor = requireActor(ctx);
  const { tenantId } = body.parse(await req.json());
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !(await switchTenant(token, actor.userId, tenantId))) {
    throw new HttpError(403, "Not a member of that company");
  }
  return Response.json({ ok: true });
});
