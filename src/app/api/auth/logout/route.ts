import { cookies } from "next/headers";
import { SESSION_COOKIE, destroySession } from "@/server/auth/sessions";
import { route } from "@/server/http";

export const POST = route(async () => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await destroySession(token);
  jar.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
});
