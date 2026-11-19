import { cookies } from "next/headers";
import { changePasswordInput } from "@/shared/schemas/trip";
import { SESSION_COOKIE, hashToken } from "@/server/auth/sessions";
import { requireActor, route } from "@/server/http";
import { changePassword } from "@/server/services/members";

export const POST = route(async (req, ctx) => {
  const actor = requireActor(ctx);
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  await changePassword(actor.userId, hashToken(token), changePasswordInput.parse(await req.json()));
  return Response.json({ ok: true });
});
