import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, resolveActor } from "./sessions";
import type { Actor } from "../policy";

/** For server components: the signed-in actor, or a redirect to /login. Must render inside <Suspense>. */
export async function requireSignedIn(): Promise<Actor> {
  const actor = await resolveActor((await cookies()).get(SESSION_COOKIE)?.value);
  if (!actor) redirect("/login");
  return actor;
}

export async function requireTenant(): Promise<Actor & { tenantId: string }> {
  const actor = await requireSignedIn();
  if (!actor.tenantId) redirect("/app/no-company");
  return actor as Actor & { tenantId: string };
}
