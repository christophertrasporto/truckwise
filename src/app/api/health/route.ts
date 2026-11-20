import { sql } from "drizzle-orm";
import { withContext } from "@/server/db";
import { logger } from "@/server/logger";

/** For the hosting platform's health check: answers 200 only when the database is reachable. The reply reveals nothing else. */
export async function GET() {
  try {
    await withContext({}, (db) => db.execute(sql`select 1`));
    return Response.json({ ok: true });
  } catch (err) {
    // The reason goes to the server log only (never to the caller), so a bad connection setting can be diagnosed.
    const e = err as { message?: string; code?: string; cause?: { message?: string; code?: string } };
    logger.error({ code: e.code ?? e.cause?.code, message: e.cause?.message ?? e.message }, "health check: database not reachable");
    return Response.json({ ok: false }, { status: 503 });
  }
}
