import type { Application } from "../../application";

export async function workOne(app: Application): Promise<boolean> {
  const job = await app.store.claimJob();
  if (!job) return false;
  const renew = setInterval(() => { void app.store.renewJob(job.id, job.fence).then(valid => { if (!valid) app.cancellations.get(job.payload.id)?.abort(); }).catch(() => app.cancellations.get(job.payload.id)?.abort()); }, 5000);
  try { await app.processJob(job); await app.store.finishJob(job.id, job.fence); }
  catch { await app.store.finishJob(job.id, job.fence, "Job processing failed"); }
  finally { clearInterval(renew); }
  return true;
}
export async function runWorker(app: Application, signal: AbortSignal): Promise<void> {
  // Recover the narrow create-run/enqueue crash window without depending on the browser retry.
  for (const r of await app.store.listRuns()) if (r.status === "pending" || r.status === "running") await app.store.enqueueJob(`run:${r.id}`, "run", r.id);
  for (const a of await app.store.pendingAnalyses()) await app.store.enqueueJob(`analysis:${a.id}`, "analysis", a.id);
  while (!signal.aborted) {
    try { if (await workOne(app)) continue; }
    catch { /* Storage outage: never fall back to memory; retry without losing the durable job. */ }
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(t); signal.removeEventListener("abort", finish); resolve(); };
      const t = setTimeout(finish, 200);
      if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
    });
  }
}
