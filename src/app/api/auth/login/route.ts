import { cookies } from "next/headers";
import { z } from "zod";
import { SESSION_COOKIE, createSession, verifyCredentials } from "@/server/auth/sessions";
import { env } from "@/server/env";
import { assertLoginAllowed, clearFailedLogins, clientAddress, recordFailedLogin } from "@/server/auth/login-limit";
import { HttpError, route } from "@/server/http";

const body = z.object({ email: z.string().email(), password: z.string().min(1) });

export const POST = route(async (req, ctx) => {
  const { email, password } = body.parse(await req.json());
  const ip = clientAddress(req);
  await assertLoginAllowed(email, ip);
  const userId = await verifyCredentials(email, password);
  if (!userId) {
    await recordFailedLogin(email, ip);
    ctx.log.info("login failed");
    throw new HttpError(401, "Invalid email or password");
  }
  await clearFailedLogins(email);
  const { token, expiresAt } = await createSession(userId, env().SESSION_TTL_DAYS);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().COOKIE_SECURE,
    path: "/",
    expires: expiresAt,
  });
  ctx.log.info({ loginUserId: userId }, "login ok");
  return Response.json({ ok: true });
});
