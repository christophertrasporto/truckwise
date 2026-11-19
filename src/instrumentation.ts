/**
 * Runs once when the server starts. In a single-server deployment this keeps the background job queue
 * (file scanning, display copies, automatic approvals, retries) moving even if no request triggers it.
 * Set RUN_JOBS_IN_PROCESS=false to run the worker separately with `npm run jobs:work`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("@/server/env")).assertLiveSettings();
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.RUN_JOBS_IN_PROCESS === "false") return;
  const { drainJobs } = await import("@/server/jobs/queue");
  await import("@/server/jobs/handlers");
  const { enqueueAutomationTick } = await import("@/server/notify/handlers");
  // Every 15 seconds: queue this minute's timer job (one per minute, however many servers run), then do the work.
  const tick = async () => {
    await enqueueAutomationTick().catch(() => undefined);
    await drainJobs().catch(() => undefined);
  };
  setInterval(tick, 15_000).unref();
}
