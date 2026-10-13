// Scheduled jobs (design D10). wrangler.toml runs the Worker's scheduled()
// handler every 15 minutes; it calls runJobs(), which runs every registered
// job in order. A failing job is logged and the others still run. Every job
// must be idempotent (safe to run twice), since Cloudflare may retry a cron
// invocation and runs can overlap.
//
// Jobs live in lib/jobs/*.js, each exporting `jobs = [{ name, run }]` where
// run(env, { now }) returns a small JSON-able result. Phase 2 fills
// jobs/parent.js (trial follow-ups) and jobs/ops.js (reminders, overdue
// nudges) without touching this file or index.js.

import { nowIso } from './db.js';
import { logEvent, logError } from './log.js';
import { jobs as coreJobs } from './jobs/core.js';
import { jobs as parentJobs } from './jobs/parent.js';
import { jobs as opsJobs } from './jobs/ops.js';

export function allJobs() {
  return [...coreJobs, ...parentJobs, ...opsJobs];
}

// Run the registry (or the jobs named in `only`). Returns
// [{ name, ok, result | error, ms }].
export async function runJobs(env, { now = nowIso(), only = null, jobs = allJobs() } = {}) {
  const results = [];
  for (const job of jobs) {
    if (only && !only.includes(job.name)) continue;
    const started = Date.now();
    try {
      const result = await job.run(env, { now });
      results.push({ name: job.name, ok: true, result: result ?? null, ms: Date.now() - started });
      logEvent('cron_job_done', { job: job.name, ms: Date.now() - started });
    } catch (err) {
      results.push({ name: job.name, ok: false, error: String(err && err.message), ms: Date.now() - started });
      logError('cron_job_failed', err, { job: job.name });
    }
  }
  return results;
}
