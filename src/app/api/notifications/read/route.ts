import { requireTenantActor, route } from "@/server/http";
import { markRead, markReadInput } from "@/server/notify/service";

export const POST = route(async (req, ctx) => Response.json(await markRead(requireTenantActor(ctx), markReadInput.parse(await req.json()))));
