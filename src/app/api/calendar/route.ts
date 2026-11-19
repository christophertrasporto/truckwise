import { z } from "zod";
import { requireTenantActor, route } from "@/server/http";
import { queryObject } from "@/server/query";
import { calendarForStaff } from "@/server/services/calendar";

const q = z.object({ from: z.string().date(), days: z.coerce.number().int().min(1).max(31).default(7) });

export const GET = route(async (req, ctx) => {
  const { from, days } = q.parse(queryObject(req));
  return Response.json(await calendarForStaff(requireTenantActor(ctx), from, days));
});
