import { requireTenantActor, route } from "@/server/http";
import { reviewDocument } from "@/server/services/documents";

export const POST = route<{ fileId: string }>(async (req, ctx, { fileId }) => Response.json(await reviewDocument(requireTenantActor(ctx), fileId, await req.json(), { requestId: ctx.requestId })));
