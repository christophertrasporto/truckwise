import { sql } from "drizzle-orm";
import { withContext } from "@/server/db";

/** For the hosting platform's health check: answers 200 only when the database is reachable. Reveals nothing else. */
export async function GET() {
  try {
    await withContext({}, (db) => db.execute(sql`select 1`));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
