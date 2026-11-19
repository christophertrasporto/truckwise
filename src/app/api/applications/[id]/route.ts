import { requireTenantActor, route } from "@/server/http";
import { getApplication } from "@/server/services/applications";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => Response.json(await getApplication(requireTenantActor(ctx), id)));
