import { requireTenantActor, route } from "@/server/http";
import { addDocumentType, listDocumentTypes } from "@/server/services/documents";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => Response.json({ types: await listDocumentTypes(requireTenantActor(ctx), id) }));

export const POST = route<{ id: string }>(async (req, ctx, { id }) => Response.json(await addDocumentType(requireTenantActor(ctx), id, await req.json(), { requestId: ctx.requestId }), { status: 201 }));
