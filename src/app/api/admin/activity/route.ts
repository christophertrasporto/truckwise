import { requireActor, route } from "@/server/http";
import { platformActivity } from "@/server/services/admin";

export const GET = route(async (_req, ctx) => Response.json({ activity: await platformActivity(requireActor(ctx)) }));
