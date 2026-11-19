import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(14),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * When APP_ENV=live the server refuses to start with settings that are fine on a laptop but unsafe on the internet.
 * Called once at start-up (instrumentation.ts), so a bad deploy fails loudly instead of running half-secure.
 */
export function assertLiveSettings(e: Record<string, string | undefined> = process.env): void {
  if (e.APP_ENV !== "live") return;
  const problems: string[] = [];
  if (e.COOKIE_SECURE !== "true") problems.push("COOKIE_SECURE must be true (the site is served over HTTPS)");
  const secret = e.STORAGE_SIGNING_SECRET ?? "";
  if (secret.length < 32 || secret === "change-me") problems.push("STORAGE_SIGNING_SECRET must be a random string of at least 32 characters");
  if (!e.STORAGE_DIR || !e.STORAGE_DIR.startsWith("/")) problems.push("STORAGE_DIR must be an absolute path on a persistent volume, for example /data/storage");
  if (/localhost|127\.0\.0\.1/.test(e.DATABASE_URL ?? "")) problems.push("DATABASE_URL points at this machine; use the hosted database");
  if (/smartload_app:smartload_app@/.test(e.DATABASE_URL ?? "")) problems.push("DATABASE_URL still uses the default development password");
  if (problems.length) throw new Error("Unsafe live configuration:\n - " + problems.join("\n - "));
}

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
