import { storage, verifySignedRequest } from "@/server/storage";

const mimeByExt: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Serves a stored object only for a valid, unexpired signature issued after a permission check. */
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key: parts } = await params;
  const key = parts.map(decodeURIComponent).join("/");
  const url = new URL(req.url);
  const ok = verifySignedRequest(key, Number(url.searchParams.get("exp")), url.searchParams.get("sig") ?? "");
  if (!ok) return new Response("Forbidden", { status: 403 });
  try {
    const data = await storage.get(key);
    const ext = key.split(".").pop() ?? "";
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": mimeByExt[ext] ?? "application/octet-stream",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
