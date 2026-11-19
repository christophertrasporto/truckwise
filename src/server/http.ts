import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { after } from "next/server";
import { ZodError } from "zod";
import { SESSION_COOKIE, resolveActor } from "./auth/sessions";
import { HttpError } from "./errors";
import "./jobs/handlers";
import { drainJobs } from "./jobs/queue";
import { childLogger } from "./logger";
import { InvalidTransitionError } from "@/shared/state-machines/trip";
import { ForbiddenError, type Actor } from "./policy";

export { HttpError };

export interface RouteCtx {
  requestId: string;
  actor: Actor | null;
  log: ReturnType<typeof childLogger>;
}

export function requireActor(ctx: RouteCtx): Actor {
  if (!ctx.actor) throw new HttpError(401, "Not authenticated");
  return ctx.actor;
}

/** An actor with an active tenant. Most tenant-scoped endpoints use this. */
export function requireTenantActor(ctx: RouteCtx): Actor & { tenantId: string } {
  const a = requireActor(ctx);
  if (!a.tenantId) throw new HttpError(403, "No active company");
  return a as Actor & { tenantId: string };
}

/** Wraps a route handler: request id, session -> actor, structured logging, uniform error mapping. */
export function route<P = Record<string, never>>(
  fn: (req: Request, ctx: RouteCtx, params: P) => Promise<Response>,
) {
  return async (req: Request, segment?: { params: Promise<P> }): Promise<Response> => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const actor = await resolveActor(token);
    const log = childLogger({ requestId, tenantId: actor?.tenantId ?? null, userId: actor?.userId ?? null });
    try {
      const res = await fn(req, { requestId, actor, log }, (await segment?.params) as P);
      res.headers.set("x-request-id", requestId);
      // A change just happened: run the background work it queued (alerts, file checks) right after the reply,
      // so people hear about it within seconds instead of waiting for the next timer.
      if (req.method !== "GET" && res.status < 400) after(() => drainJobs({ limit: 50 }).then(() => undefined, () => undefined));
      return res;
    } catch (err) {
      let status = 500;
      let message = "Internal error";
      const code = (err as { code?: unknown })?.code;
      if (err instanceof HttpError || err instanceof ForbiddenError || err instanceof InvalidTransitionError)
        ({ status, message } = err);
      else if (err instanceof ZodError) {
        status = 400;
        message = "Invalid request";
      }
      if (status >= 500) log.error({ err }, "unhandled error");
      else log.info({ status, message }, "request rejected");
      return Response.json(
        { error: message, requestId, ...(typeof code === "string" && /^[a-z_]+$/.test(code) ? { code } : {}), ...(err instanceof ZodError ? { issues: err.issues } : {}) },
        { status, headers: { "x-request-id": requestId } },
      );
    }
  };
}
