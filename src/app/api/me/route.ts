import { route, requireActor } from "@/server/http";

export const GET = route(async (_req, ctx) => {
  const a = requireActor(ctx);
  return Response.json({
    userId: a.userId,
    tenantId: a.tenantId,
    tenantKind: a.tenantKind,
    role: a.role,
    isPlatformAdmin: a.isPlatformAdmin,
  });
});
