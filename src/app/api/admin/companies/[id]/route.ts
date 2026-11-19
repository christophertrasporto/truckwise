import { requireActor, route } from "@/server/http";
import { getCompany } from "@/server/services/admin";

export const GET = route<{ id: string }>(async (_req, ctx, { id }) => Response.json(await getCompany(requireActor(ctx), id)));
