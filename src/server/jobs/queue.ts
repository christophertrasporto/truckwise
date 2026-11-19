import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { withContext, type Db } from "../db";
import { jobs } from "../db/schema";
import { logger } from "../logger";

/**
 * A small database-backed job queue.
 *  - enqueue() is idempotent per dedupeKey, so retrying the code that enqueues never duplicates work.
 *  - drainJobs() claims one job at a time with FOR UPDATE SKIP LOCKED, so several workers can run safely.
 *  - failures retry with exponential backoff up to maxAttempts, then stay "failed" for inspection.
 *  - a job stuck "running" (a crashed worker) is reclaimed after STALE_MS.
 * Handlers must be idempotent: a job can run more than once.
 */
export interface JobRecord {
  id: string;
  tenantId: string | null;
  type: string;
  payload: unknown;
  attempts: number;
}
export type JobHandler = (payload: never, job: JobRecord) => Promise<void>;

const handlers = new Map<string, JobHandler>();
export const registerJob = (type: string, fn: JobHandler) => void handlers.set(type, fn);

const STALE_MS = 5 * 60_000;

export async function enqueue(
  db: Db,
  input: { tenantId: string | null; type: string; payload: unknown; dedupeKey: string; runAt?: Date; maxAttempts?: number },
) {
  await db
    .insert(jobs)
    .values({
      tenantId: input.tenantId,
      type: input.type,
      payload: input.payload as object,
      dedupeKey: input.dedupeKey,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey });
}

/** Seconds to wait before attempt N+1: 30, 60, 120, ... capped at 1 hour. `backoffBaseMs` is overridable for tests. */
export const backoffMs = (attempts: number, baseMs = 30_000) => Math.min(baseMs * 2 ** (attempts - 1), 3_600_000);

async function claim(): Promise<(JobRecord & { maxAttempts: number }) | null> {
  return withContext({ platform: true }, async (db) => {
    const [row] = await db
      .select()
      .from(jobs)
      .where(
        and(
          sql`${jobs.runAt} <= now()`,
          or(eq(jobs.status, "queued"), and(eq(jobs.status, "running"), lt(jobs.lockedAt, new Date(Date.now() - STALE_MS)))),
        ),
      )
      .orderBy(jobs.runAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    await db.update(jobs).set({ status: "running", lockedAt: new Date(), attempts: row.attempts + 1 }).where(eq(jobs.id, row.id));
    return { id: row.id, tenantId: row.tenantId, type: row.type, payload: row.payload, attempts: row.attempts + 1, maxAttempts: row.maxAttempts };
  });
}

/** Runs due jobs until none remain (or `limit` jobs ran). Returns how many succeeded and failed in this call. */
export async function drainJobs(opts: { limit?: number; backoffBaseMs?: number } = {}) {
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < (opts.limit ?? 50); i++) {
    const job = await claim();
    if (!job) break;
    try {
      const handler = handlers.get(job.type);
      if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
      await handler(job.payload as never, job);
      await withContext({ platform: true }, (db) => db.update(jobs).set({ status: "done", finishedAt: new Date(), lockedAt: null, lastError: null }).where(eq(jobs.id, job.id)));
      ok++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const dead = job.attempts >= job.maxAttempts;
      logger.warn({ jobId: job.id, type: job.type, attempts: job.attempts, dead, err: message }, "job failed");
      await withContext({ platform: true }, (db) =>
        db
          .update(jobs)
          .set({
            status: dead ? "failed" : "queued",
            lockedAt: null,
            lastError: message.slice(0, 1000),
            finishedAt: dead ? new Date() : null,
            runAt: dead ? undefined : new Date(Date.now() + backoffMs(job.attempts, opts.backoffBaseMs)),
          })
          .where(eq(jobs.id, job.id)),
      );
    }
  }
  return { ok, failed };
}

export async function jobCounts(types?: string[]) {
  return withContext({ platform: true }, async (db) => {
    const rows = await db
      .select({ status: jobs.status, n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(types ? inArray(jobs.type, types) : undefined)
      .groupBy(jobs.status);
    return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  });
}
