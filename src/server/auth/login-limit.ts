import { createHash } from "node:crypto";
import { and, count, eq, gte, lt } from "drizzle-orm";
import { withContext } from "../db";
import { loginAttempts } from "../db/schema";
import { HttpError } from "../errors";

const WINDOW_MS = 15 * 60_000;
const MAX_PER_EMAIL = 8;
const MAX_PER_ADDRESS = 40;

const h = (v: string) => createHash("sha256").update(v.toLowerCase().trim()).digest("hex");

/** The caller's address as the hosting platform reports it. Only used to slow down guessing, never trusted for access. */
export const clientAddress = (req: Request) => (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() || "unknown";

/** Refuses (429) when this email or this address has failed too often in the last 15 minutes. Call before checking the password. */
export async function assertLoginAllowed(email: string, ip: string): Promise<void> {
  const since = new Date(Date.now() - WINDOW_MS);
  const [byEmail, byIp] = await withContext({}, async (db) => [
    (await db.select({ n: count() }).from(loginAttempts).where(and(eq(loginAttempts.emailHash, h(email)), gte(loginAttempts.at, since))))[0].n,
    (await db.select({ n: count() }).from(loginAttempts).where(and(eq(loginAttempts.ipHash, h(ip)), gte(loginAttempts.at, since))))[0].n,
  ]);
  if (Number(byEmail) >= MAX_PER_EMAIL || Number(byIp) >= MAX_PER_ADDRESS) {
    throw Object.assign(new HttpError(429, "Too many failed sign-in attempts. Wait 15 minutes and try again."), { code: "rate_limited" });
  }
}

export async function recordFailedLogin(email: string, ip: string): Promise<void> {
  await withContext({}, (db) => db.insert(loginAttempts).values({ emailHash: h(email), ipHash: h(ip) }));
}

/** A successful sign-in clears that email's recent failures. */
export async function clearFailedLogins(email: string): Promise<void> {
  await withContext({}, (db) => db.delete(loginAttempts).where(eq(loginAttempts.emailHash, h(email))));
}

/** Housekeeping for the timer: failures older than a day are no use. */
export async function purgeOldLoginAttempts(): Promise<void> {
  await withContext({ platform: true }, (db) => db.delete(loginAttempts).where(lt(loginAttempts.at, new Date(Date.now() - 24 * 3600_000))));
}
