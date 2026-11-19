import { memberInput } from "@/shared/schemas/trip";
import { requireTenantActor, route } from "@/server/http";
import { addMember, listMembers } from "@/server/services/members";

export const GET = route(async (_req, ctx) => Response.json({ members: await listMembers(requireTenantActor(ctx)) }));

export const POST = route(async (req, ctx) => {
  const res = await addMember(requireTenantActor(ctx), memberInput.parse(await req.json()), { requestId: ctx.requestId });
  return Response.json(res, { status: 201 });
});
