import { requireActor, route } from "@/server/http";
import { platformDashboard } from "@/server/services/admin";

export const GET = route(async (_req, ctx) => Response.json(await platformDashboard(requireActor(ctx))));
