import "../src/server/jobs/handlers";
import { drainJobs } from "../src/server/jobs/queue";
import { enqueueAutomationTick } from "../src/server/notify/handlers";

/** Dedicated worker: polls the job queue every few seconds. Run beside the app when RUN_JOBS_IN_PROCESS=false. */
console.log("job worker started");
for (;;) {
  await enqueueAutomationTick();
  const r = await drainJobs();
  if (r.ok + r.failed > 0) console.log(`ran ${r.ok + r.failed} job(s): ${r.ok} ok, ${r.failed} failed`);
  await new Promise((res) => setTimeout(res, 5_000));
}
