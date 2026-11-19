import { z } from "zod";
import { requireActor, route } from "@/server/http";
import { subscribePush, subscriptionInput, unsubscribePush } from "@/server/notify/service";

export const POST = route(async (req, ctx) => {
  await subscribePush(requireActor(ctx), subscriptionInput.parse(await req.json()), req.headers.get("user-agent"));
  return Response.json({ ok: true }, { status: 201 });
});

export const DELETE = route(async (req, ctx) => {
  const { endpoint } = z.object({ endpoint: z.string().url() }).parse(await req.json());
  await unsubscribePush(requireActor(ctx), endpoint);
  return Response.json({ ok: true });
});
